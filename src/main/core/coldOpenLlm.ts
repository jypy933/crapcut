// Asks the local language model one yes/no question about a cold open that
// already passed the deterministic gate (`coldOpen.ts`): does the setup make
// the payoff land, and would the payoff make sense to someone who has not
// seen what came before? The model only ever answers a boolean about text the
// clip itself contains; it never writes anything shown on screen. A model
// that is missing, fails or answers badly gives `unavailable`, and the
// stricter no-model gate applies -- the clip is never blocked on it.

import { z } from 'zod'
import type { Word } from '@shared/types'
import type { ColdOpenLlmVerdict } from '@shared/editPlan'
import type { CompleteFn } from './structureLlm'

export const COLD_OPEN_SYSTEM_PROMPT = [
  'You judge whether a short video clip should open with a preview of its punchline. Answer with the requested JSON object only, nothing else.',
  '',
  'You get the words spoken before the punchline (the setup) and the words of the punchline preview that would be shown first.',
  'Answer worthIt true only when both hold: the setup builds up to the punchline, and the preview alone still makes sense and is interesting to someone who has not seen the setup.',
  'Answer worthIt false when the setup is unrelated to the preview, the preview is a fragment that needs the setup to make sense, or there is no real payoff.',
  '',
  'Example:',
  'Setup: "okay so I have one shot left and the boss is almost dead I just need to land this"',
  'Preview: "YES let\'s go no way I actually did it"',
  'Answer: {"worthIt": true}',
  '',
  'Example:',
  'Setup: "so anyway I was going to go get some water and then"',
  'Preview: "the second one is the blue one"',
  'Answer: {"worthIt": false}'
].join('\n')

export const COLD_OPEN_ANSWER_SCHEMA = {
  type: 'object',
  properties: { worthIt: { type: 'boolean' } },
  required: ['worthIt'],
  additionalProperties: false
} as const

const Answer = z.object({ worthIt: z.boolean() })

/** How many of the words just before the preview the model is shown. */
const SETUP_WORDS_SHOWN = 40

const text = (words: Word[]): string =>
  words
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(' ')

/** The user message: the setup's last words and the preview's words, both verbatim from the clip. */
export function buildColdOpenPrompt(words: Word[], preview: { srcStart: number; srcEnd: number }): string {
  const setup = words.filter((w) => w.t1 <= preview.srcStart + 1e-6).slice(-SETUP_WORDS_SHOWN)
  const shown = words.filter((w) => w.t0 >= preview.srcStart - 1e-6 && w.t1 <= preview.srcEnd + 1e-6)
  return ['Now the real clip.', `Setup: "${text(setup) || '(no speech)'}"`, `Preview: "${text(shown) || '(no speech)'}"`, 'Answer as JSON: {"worthIt": boolean}'].join('\n')
}

/** The model's answer as a boolean, or null when it does not parse. */
export function parseColdOpenAnswer(raw: string): boolean | null {
  try {
    const parsed = Answer.safeParse(JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)))
    return parsed.success ? parsed.data.worthIt : null
  } catch {
    return null
  }
}

/** One request; any failure or unusable answer is `unavailable` (this never throws for that reason). */
export async function confirmColdOpen(words: Word[], preview: { srcStart: number; srcEnd: number }, complete: CompleteFn): Promise<ColdOpenLlmVerdict> {
  let raw: string
  try {
    raw = await complete(buildColdOpenPrompt(words, preview), COLD_OPEN_ANSWER_SCHEMA)
  } catch {
    return 'unavailable'
  }
  const answer = parseColdOpenAnswer(raw)
  return answer === null ? 'unavailable' : answer ? 'confirmed' : 'rejected'
}
