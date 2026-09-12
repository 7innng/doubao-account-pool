import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractVideoUrlFromPayload,
  getWatermarkRetryDelays,
  hasDolaShareVideoResource,
  isMp4VideoUrl,
  isRetryableWatermarkError,
  verifyPlayableVideoUrl,
  WATERMARK_RETRY_DELAYS_MS,
  withMp4ExtensionHint,
} from '../dist-electron/watermark.js'

test('requires a real video resource in a copied Dola share page', () => {
  const valid = `
    你的视频生成好了。
    {\\"creation_block\\":{\\"video\\":{\\"cover\\":\\"video_dsz_watermark_1_6.png\\",
    \\"video_type\\":\\"mp4\\",\\"download_url\\":\\"https:\\u002F\\u002Fcdn.example.com\\u002Fvideo?mime_type=video_mp4\\"}}}
  `
  assert.equal(hasDolaShareVideoResource(valid), true)
  assert.equal(hasDolaShareVideoResource('你的视频生成好了，但只有普通对话内容'), false)
  assert.equal(hasDolaShareVideoResource('download_url mime_type=video_mp4'), false)
})

test('extracts a nested MP4 result', () => {
  const url = 'https://cdn.example.com/video/result.mp4?token=test'
  assert.equal(extractVideoUrlFromPayload({ data: { playUrl: url } }), url)
})

test('extracts an extensionless download URL and adds an MP4 hint', () => {
  const url = 'https://cdn.example.com/download?id=video&token=test'
  assert.equal(extractVideoUrlFromPayload({ data: { download_url: url } }), `${url}#video.mp4`)
})

test('accepts common MP4 URL formats', () => {
  assert.equal(isMp4VideoUrl('https://cdn.example.com/video?id=1&format=mp4'), true)
  assert.equal(isMp4VideoUrl('https://example.com/share/page'), false)
})

test('adds an MP4 hint without changing the signed HTTP request path', () => {
  const source = 'https://cdn.example.com/download?id=1&token=signed'
  const hinted = withMp4ExtensionHint(source)
  assert.equal(hinted, `${source}#video.mp4`)
  assert.equal(new URL(hinted).pathname, '/download')
  assert.equal(new URL(hinted).search, '?id=1&token=signed')
})

test('accepts HTTP 206 binary octet-stream video responses', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new Uint8Array([0, 0, 0, 24]), {
    status: 206,
    headers: { 'Content-Type': 'binary/octet-stream' },
  })
  try {
    await assert.doesNotReject(() => verifyPlayableVideoUrl('https://cdn.example.com/download#video.mp4'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('retries eventual-consistency failures from the watermark provider', () => {
  assert.equal(isRetryableWatermarkError(new Error('去水印接口失败：未找到资源或获取失败')), true)
  assert.equal(isRetryableWatermarkError(new Error('去水印接口失败：资源处理中，请稍后重试')), true)
  assert.equal(isRetryableWatermarkError(new Error('去水印接口失败：解析失败')), true)
})

test('does not retry unsupported platforms', () => {
  assert.equal(isRetryableWatermarkError(new Error('去水印接口返回：平台暂不支持')), false)
})

test('uses a short first retry and bounded backoff', () => {
  assert.deepEqual([...WATERMARK_RETRY_DELAYS_MS], [0, 5000, 15000, 30000, 60000])
  assert.deepEqual([...getWatermarkRetryDelays(3)], [0, 5000, 15000])
  assert.deepEqual([...getWatermarkRetryDelays(99)], [...WATERMARK_RETRY_DELAYS_MS])
})
