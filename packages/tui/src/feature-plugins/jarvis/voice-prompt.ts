// v2 prompts have no per-request system field, so these are admitted as hidden synthetic messages:
// the first when a voice prompt reaches a session, the second when voice mode ends in it.

export const VOICE_MODE_SYSTEM_PROMPT =
  "The user is in voice mode. Your response will be read aloud via TTS.\n\n" +
  "- Be conversational and concise — speak like a colleague giving a verbal update.\n" +
  "- No code blocks, diffs, tables, diagrams, ASCII art, or markdown formatting.\n" +
  "- Describe what you did, what changed, and what needs attention in plain sentences.\n" +
  "- If you wrote or changed code, say what file and what you changed — don't show the code.\n" +
  "- If you need to show code or a diff, say so and offer to switch to text mode for details.\n" +
  "- Keep responses under 4-5 spoken sentences unless the user asks for more detail."

export const VOICE_MODE_ENDED_PROMPT =
  "The user has left voice mode. Responses are read on screen again; normal formatting is fine."
