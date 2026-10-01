import { anthropicClient } from './providers/anthropic'
import { COMPUTER_USE_MODEL } from './models'

/**
 * Use Anthropic's Computer Use API to find exact pixel coordinates of a UI element.
 * Specifically trained for clicking UI — ~95% accuracy vs ~80% for regular vision.
 * Returns screenshot-space coordinates (before scaling to screen space).
 */
export async function findClickCoordinates(
  screenshotBase64: string,
  description: string,
  imgW: number,
  imgH: number,
  signal?: AbortSignal
): Promise<{ x: number; y: number } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null
  try {
    const response = await anthropicClient().beta.messages.create(
      {
        model: COMPUTER_USE_MODEL,
        max_tokens: 256,
        betas: ['computer-use-2025-11-24'],
        tools: [
          {
            type: 'computer_20251124',
            name: 'computer',
            display_width_px: imgW,
            display_height_px: imgH
          }
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 }
              },
              { type: 'text', text: `Find and click: ${description}` }
            ]
          }
        ]
      },
      { signal }
    )
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'computer') {
        const { action, coordinate } = block.input as { action?: string; coordinate?: unknown }
        if (action === 'left_click' && Array.isArray(coordinate) && coordinate.length === 2) {
          const [x, y] = coordinate as number[]
          console.log(`[computer-use] click at screenshot (${x},${y}) for: ${description}`)
          return { x, y }
        }
      }
    }
  } catch (e) {
    console.error('[computer-use] error:', (e as Error).message)
  }
  return null
}
