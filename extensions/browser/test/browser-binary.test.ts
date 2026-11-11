import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { playwrightChromiums, sandboxHint } from '../server.ts'
import { removeTemps, temp } from '../../../test/helpers.ts'

afterEach(removeTemps)

it('finds Playwright Chromium in the macOS cache, newest build first', async () => {
  const home = await temp()
  const cache = join(home, 'Library/Caches/ms-playwright')
  for (const name of [
    'chromium-998',
    'chromium-1248',
    'chromium-1208',
    'chromium_headless_shell-1248',
  ])
    await mkdir(join(cache, name), { recursive: true })
  const app =
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  const legacy = 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'
  expect(await playwrightChromiums(home, 'darwin', 'arm64')).toEqual([
    join(cache, 'chromium-1248', app),
    join(cache, 'chromium-1248', legacy),
    join(cache, 'chromium-1208', app),
    join(cache, 'chromium-1208', legacy),
    join(cache, 'chromium-998', app),
    join(cache, 'chromium-998', legacy),
  ])
  expect(await playwrightChromiums(home, 'linux', 'x64')).toEqual([])
})

it('finds Playwright Chromium in the Linux cache, newest build first', async () => {
  const home = await temp()
  const cache = join(home, '.cache/ms-playwright')
  for (const name of [
    'chromium-998',
    'chromium-1248',
    'chromium-1208',
    'chromium_headless_shell-1248',
    'firefox-1490',
    'ffmpeg-1011',
    '.links',
  ])
    await mkdir(join(cache, name), { recursive: true })
  expect(await playwrightChromiums(home, 'linux', 'x64')).toEqual([
    join(cache, 'chromium-1248', 'chrome-linux64/chrome'),
    join(cache, 'chromium-1208', 'chrome-linux64/chrome'),
    join(cache, 'chromium-998', 'chrome-linux64/chrome'),
  ])
  expect(await playwrightChromiums(home, 'darwin', 'arm64')).toEqual([])
})

// #16704: in a pod that blocks user namespaces, the launch failed with Playwright's text alone.
it('names ULTIMATE_CHROMIUM_SANDBOX when Chromium has no usable sandbox', () => {
  const launch = new Error(
    'browserType.launch: FATAL:zygote_host_impl_linux.cc:130] No usable sandbox!',
  )
  const hinted = sandboxHint(launch) as Error
  expect(hinted.message).toContain('ULTIMATE_CHROMIUM_SANDBOX=0')
  expect(hinted.message).toContain(launch.message)
  const other = new Error('Target page, context or browser has been closed')
  expect(sandboxHint(other)).toBe(other)
})
