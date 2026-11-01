// cc-link: Settings > Security > Device keys, "Messages only" key type, in a
// real browser against the static web/ (see playwright.browser.config.ts for
// why no dashboard is booted). The API is mocked with page.route; the POST
// mock mirrors the route's contract for the messages scope (400 texts, the
// `warning` when the sender is not a SYSTEM_SENDER_IDS entry).
//
// SHOT_DIR (optional) saves the review screenshots elsewhere than test-results/.
import { test, expect, type Page, type Route } from '@playwright/test'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || 'test-results'
const LISTED_SENDERS = new Set(['cortex'])
const NOW = Math.floor(Date.UTC(2026, 9, 18) / 1000)

type Key = { id: number; name: string; createdAt: number; lastUsedAt: number | null; expiresAt: number | null; scope: string; senderId: string | null; installId: string | null }

async function openDeviceKeys(page: Page, lang: 'hu' | 'en', extraKeys: Key[] = []) {
  const errors: string[] = []
  const posts: Record<string, unknown>[] = []
  const keys: Key[] = [
    { id: 1, name: 'iPhone', createdAt: NOW - 86400 * 30, lastUsedAt: NOW - 3600, expiresAt: null, scope: 'full', senderId: null, installId: null },
    ...extraKeys,
  ]
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource.*400/.test(m.text())) errors.push(m.text())
  })

  // Catch-all FIRST: Playwright gives the last registered matching route priority.
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/settings', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ settings: [] }) }))
  await page.route('**/api/auth/status', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ method: 'token', authenticated: true }) }))
  await page.route('**/api/operator-access', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, capabilities: {}, commands: [] }) }))
  await page.route('**/api/auth/device-keys', async (r: Route) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keys }) })
    }
    const body = r.request().postDataJSON() as Record<string, unknown>
    posts.push(body)
    const reply = (status: number, b: unknown) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) })
    if (body.scope === 'messages') {
      const sender = String(body.sender_id || '')
      if (sender === 'neo') return reply(400, { error: "sender_id 'neo' is reserved (a fleet agent or a system identity)" })
      const days = (body.expires_in_days as number | undefined) ?? 90
      const k: Key = { id: keys.length + 1, name: String(body.name), createdAt: NOW, lastUsedAt: null, expiresAt: NOW + days * 86400, scope: 'messages', senderId: sender, installId: null }
      keys.push(k)
      return reply(201, {
        ok: true, id: k.id, name: k.name, key: 'mvdk_' + 'x'.repeat(40), created_at: k.createdAt, expires_at: k.expiresAt,
        scope: 'messages', sender_id: sender,
        ...(LISTED_SENDERS.has(sender) ? {} : { warning: `sender_id '${sender}' is not in SYSTEM_SENDER_IDS yet: add it to .env and restart the dashboard, or every send with this key is refused` }),
      })
    }
    const k: Key = { id: keys.length + 1, name: String(body.name), createdAt: NOW, lastUsedAt: null, expiresAt: null, scope: 'full', senderId: null, installId: null }
    keys.push(k)
    return reply(201, { ok: true, id: k.id, name: k.name, key: 'mvdk_' + 'y'.repeat(40), created_at: NOW, expires_at: null, scope: 'full' })
  })

  await page.addInitScript((l) => {
    try { localStorage.setItem('marveen.lang', l) } catch { /* ignore */ }
  }, lang)
  await page.setViewportSize({ width: 1100, height: 1400 })
  await page.goto('/index.html')
  await page.evaluate(async (l) => {
    const w = window as unknown as { _lang: string; switchPage: (p: string) => void; loadSettings: () => Promise<void> }
    w._lang = l
    w.switchPage('settings')
    // loadSettings renders the auth card itself (see bridgehu813.spec.ts).
    await w.loadSettings()
  }, lang)
  await page.locator('#authDevName').waitFor({ state: 'visible' })
  await page.locator('#authDeviceKeys').scrollIntoViewIfNeeded()
  return { errors, posts }
}

test.describe('device keys: messages-only type', () => {
  test('hu: create a messages key, with client checks, server 400 and the SYSTEM_SENDER_IDS warning', async ({ page }) => {
    const { errors, posts } = await openDeviceKeys(page, 'hu')

    // Default: full key, the messages fields hidden, the old expiry field shown.
    await expect(page.locator('input[name=authDevType][value=full]')).toBeChecked()
    await expect(page.locator('#authDevSender')).toBeHidden()
    await expect(page.locator('#authDevExpiry')).toBeVisible()
    // Every field has a visible label bound with for=, and the expiry its unit.
    await expect(page.getByLabel('Eszköz neve')).toHaveId('authDevName')
    await expect(page.getByLabel('Lejárat (nem kötelező)')).toHaveId('authDevExpiry')
    await expect(page.locator('#authDevExpiryField .auth-device-unit')).toHaveText('nap')

    // A type switch clears a stale error.
    await page.click('#authDevMintBtn')
    await expect(page.locator('#authDevMsg')).toHaveText('Adj nevet az eszköznek.')
    await page.locator('label', { hasText: 'Csak üzenetek' }).click()
    await expect(page.locator('#authDevMsg')).toHaveText('')
    await expect(page.locator('#authDevMsg')).not.toHaveClass(/err/)
    await expect(page.getByLabel('Küldő-azonosító')).toHaveId('authDevSender')
    await expect(page.getByLabel('Lejárat', { exact: true })).toHaveId('authDevMsgExpiry')
    await expect(page.locator('#authDevMsgFields .auth-device-unit')).toHaveText('nap')
    await expect(page.locator('#authDevSender')).toBeVisible()
    await expect(page.locator('#authDevMsgExpiry')).toHaveValue('90')
    await expect(page.locator('#authDevExpiry')).toBeHidden()
    // The operator section keeps its own form.
    await expect(page.locator('#opKeyName')).toBeVisible()

    // Client-side: missing sender, bad charset, expiry out of range; nothing posted.
    await page.fill('#authDevName', 'Work MacBook')
    await page.click('#authDevMintBtn')
    await expect(page.locator('#authDevMsg')).toHaveText('Az üzenetkulcshoz küldő-azonosító kell.')
    // Editing a field clears it.
    await page.fill('#authDevSender', 'laptop:work')
    await expect(page.locator('#authDevMsg')).toHaveText('')
    await page.click('#authDevMintBtn')
    await expect(page.locator('#authDevMsg')).toContainText('csak betű, szám')
    await page.fill('#authDevName', 'Work MacBook 2')
    await expect(page.locator('#authDevMsg')).toHaveText('')
    await page.fill('#authDevName', 'Work MacBook')
    await page.fill('#authDevSender', 'work-laptop')
    await page.fill('#authDevMsgExpiry', '400')
    await page.click('#authDevMintBtn')
    await expect(page.locator('#authDevMsg')).toHaveText('Az üzenetkulcsnak le kell járnia: adj meg 1 és 365 közötti napot.')
    expect(posts).toEqual([])

    // Server 400: its own text is shown.
    await page.fill('#authDevMsgExpiry', '90')
    await expect(page.locator('#authDevMsg')).toHaveText('')
    await page.fill('#authDevSender', 'neo')
    await page.click('#authDevMintBtn')
    await expect(page.locator('#authDevMsg')).toHaveText("sender_id 'neo' is reserved (a fleet agent or a system identity)")
    await expect(page.locator('#authDevMsg')).toHaveClass(/err/)

    // Retyping the sender clears the server's error too (no stale 400 under the form).
    await page.fill('#authDevSender', 'work-laptop')
    await expect(page.locator('#authDevMsg')).toHaveText('')
    await expect(page.locator('#authDevMsg')).not.toHaveClass(/err/)
    await page.locator('#authDeviceKeys').screenshot({ path: join(SHOT_DIR, 'devicekeys-messages-form-hu.png') })
    await page.click('#authDevMintBtn')

    expect(posts.at(-1)).toEqual({ name: 'Work MacBook', scope: 'messages', sender_id: 'work-laptop', expires_in_days: 90 })
    await expect(page.locator('#authDevMintedKey')).toHaveValue(/^mvdk_x+$/)
    // A successful create leaves no error behind.
    await expect(page.locator('#authDevMsg')).toHaveText('')
    await expect(page.locator('#authDevMsg')).not.toHaveClass(/err/)
    const warn = page.locator('#authDevMintedWarn')
    await expect(warn).toBeVisible()
    await expect(warn).toContainText('work-laptop')
    await expect(warn).toContainText('SYSTEM_SENDER_IDS')
    await expect(warn).toContainText('újra')
    const guide = page.locator('#authDevMintedGuide')
    await expect(guide).toContainText('MARVEEN_DEVICE_KEY')
    await expect(guide).toContainText('.mcp.json')
    await expect(guide).toContainText('MARVEEN_SENDER_ID legyen ugyanez az azonosító: work-laptop')

    // List row: messages badge with the expiry next to it.
    const row = page.locator('.auth-device-row', { hasText: 'Work MacBook' })
    await expect(row.locator('.auth-device-bridge-badge').first()).toHaveText('Üzenetek: work-laptop')
    await expect(row.locator('.auth-device-expiry-badge')).toContainText('lejár:')
    // The form reset to its defaults for the next key.
    await expect(page.locator('#authDevSender')).toHaveValue('')
    await expect(page.locator('#authDevMsgExpiry')).toHaveValue('90')

    await page.locator('#authDeviceKeys').screenshot({ path: join(SHOT_DIR, 'devicekeys-messages-minted-hu.png') })
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('en: a listed sender gets no warning; a full key is unchanged and shows no guide', async ({ page }) => {
    const { errors, posts } = await openDeviceKeys(page, 'en')

    await page.locator('label', { hasText: 'Messages only' }).click()
    await page.fill('#authDevName', 'Work laptop')
    await page.fill('#authDevSender', 'cortex')
    await page.fill('#authDevMsgExpiry', '')
    await page.click('#authDevMintBtn')
    expect(posts.at(-1)).toEqual({ name: 'Work laptop', scope: 'messages', sender_id: 'cortex' })
    await expect(page.locator('#authDevMintedGuide')).toContainText('Never in a project .mcp.json')
    await expect(page.locator('#authDevMintedWarn')).toHaveCount(0)

    // A server 400 cleared by switching the type.
    await page.fill('#authDevName', 'Reserved')
    await page.fill('#authDevSender', 'neo')
    await page.click('#authDevMintBtn')
    await expect(page.locator('#authDevMsg')).toHaveClass(/err/)
    await page.locator('label', { hasText: 'Full access' }).click()
    await expect(page.locator('#authDevMsg')).toHaveText('')
    await expect(page.locator('#authDevSender')).toBeHidden()
    await expect(page.getByLabel('Device name')).toHaveId('authDevName')
    await expect(page.getByLabel('Expiry (optional)')).toHaveId('authDevExpiry')
    await expect(page.locator('#authDevExpiryField .auth-device-unit')).toHaveText('days')
    await page.fill('#authDevName', 'Phone')
    await page.click('#authDevMintBtn')
    expect(posts.at(-1)).toEqual({ name: 'Phone' })
    await expect(page.locator('#authDevMintedKey')).toHaveValue(/^mvdk_y+$/)
    await expect(page.locator('#authDevMintedGuide')).toHaveCount(0)
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  // A stored scope the server does not know is refused outright (no access);
  // the list must say so instead of showing a plain, full-looking row.
  for (const [lang, text] of [['hu', 'Ismeretlen típus: nincs hozzáférés, vond vissza'], ['en', 'Unknown type: no access, revoke it']] as const) {
    test(`${lang}: a key with an unknown scope gets the revoke badge; a full key gets none`, async ({ page }) => {
      const { errors } = await openDeviceKeys(page, lang, [
        { id: 7, name: 'Future key', createdAt: NOW - 86400, lastUsedAt: null, expiresAt: null, scope: 'unknown', senderId: null, installId: null },
        { id: 8, name: 'Bridge future', createdAt: NOW - 86400, lastUsedAt: null, expiresAt: null, scope: 'unknown', senderId: null, installId: 'marveen-remote:1234' },
      ])
      const odd = page.locator('.auth-device-row', { hasText: 'Future key' })
      await expect(odd.locator('.auth-device-unknown-badge')).toHaveText(text)
      await expect(odd.locator('.auth-device-unknown-badge')).toBeVisible()
      await expect(odd.locator('.auth-device-revoke')).toBeVisible()
      // A Bridge-paired key with an unknown scope shows BOTH badges.
      const bridged = page.locator('.auth-device-row', { hasText: 'Bridge future' })
      await expect(bridged.locator('.auth-device-unknown-badge')).toHaveText(text)
      await expect(bridged.locator('.auth-device-bridge-badge', { hasText: 'Bridge' }).first()).toBeVisible()
      await expect(bridged.locator('.auth-device-bridge-badge')).toHaveCount(2)
      const full = page.locator('.auth-device-row', { hasText: 'iPhone' })
      await expect(full.locator('.auth-device-unknown-badge')).toHaveCount(0)
      await expect(full.locator('.auth-device-bridge-badge')).toHaveCount(0)
      expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    })
  }
})
