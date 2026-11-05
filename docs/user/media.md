# Images and video

Agents on any provider can make and edit images, and make video clips, with your own API keys. Ask for one ("make a hero image of a lighthouse at dusk", "make that warmer", "a 5 second clip of it"). The agent saves the result in the project and the thread shows it.

## Set up

Open Settings → Media and add a key for the backends you want:

- **OpenAI** makes and edits images with the gpt-image models. The default is the newest one your account lists.
- **Gemini** makes and edits images.
- **fal.ai** makes video with Seedance, Kling and Veo.

A key can be pasted here or read from a secret provider such as 1Password. If you leave a key empty, the server uses `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and `FAL_KEY` from its environment. Without a key for the backend a call needs, the agent is told to add one in Settings → Media.

Codex also has a built-in image tool. It is the cheaper first choice for Codex threads, since the media tools bill your own keys.

## Where files go

Each result is saved to `.baton/media/<date>/` in the project, next to a small `.json` file that records the prompt, model and cost. T3 Code adds `.baton/` to the repository's local exclude list (`.git/info/exclude`), so it never shows up in your changes. Agents can list earlier results, and a video that was still rendering after ten minutes can be picked up later.

## Cost

Each call reports its cost. OpenAI and Gemini costs come from the usage the API returns; video costs and some image costs are estimates from a price table and are marked as such.

Each project has a daily spend cap, $5 by default, set in Settings → Media along with today's spend. A call that would pass the cap is refused before it is sent. Spend counts the estimate for a video when it starts, and the day ends at midnight UTC.

Media tools write files and spend money, so they are not available in plan mode.
