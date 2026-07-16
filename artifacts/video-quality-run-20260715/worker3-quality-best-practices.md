# AI Video Quality Best Practices: Avoiding "AI Slop" in Short-Form Marketing Content

**Report Date:** July 15, 2026  
**Focus:** Text-to-video generation for 8-10 second vertical (9:16) Facebook Reels  
**Context:** Electrical services marketing automation  

---

## Table of Contents
1. [Common AI Video Artifacts and How to Avoid Them](#1-common-ai-video-artifacts-and-how-to-avoid-them)
2. [Prompt Engineering Techniques for Video Generation](#2-prompt-engineering-techniques-for-video-generation)
3. [Post-Processing Techniques to Improve Quality](#3-post-processing-techniques-to-improve-quality)
4. [Model-Specific Quality Tips](#4-model-specific-quality-tips)
5. [Quality Verification Approaches](#5-quality-verification-approaches)
6. [Facebook Reel-Specific Optimization](#6-facebook-reel-specific-optimization)
7. [Actionable Recommendations for This Pipeline](#7-actionable-recommendations-for-this-pipeline)

---

## 1. Common AI Video Artifacts and How to Avoid Them

AI video models predict frames probabilistically — they do not have a physics engine, object permanence, or understanding of 3D space. When prompts lack clear spatial or temporal cues, the model "guesses," producing artifacts. Understanding *why* artifacts occur is the foundation for preventing them.

**Source:** [Genra.ai — "Why Your AI Videos Look Fake: 7 Fixes for Common AI Artifacts"](https://genra.ai/blog/why-ai-videos-look-fake-how-to-fix) (February 2026)  
**Source:** [aifruit.app — "How to Fix AI Video Quality Issues: Complete Guide"](https://aifruit.app/blog/how-to-fix-ai-video-quality-issues) (May 2026)

### 1.1 Morphing / Walking Through Walls

**What it looks like:** Characters or objects pass through solid surfaces, walls deform, or body parts merge with the environment. Scene geometry shifts between frames.

**Why it happens:** The model lacks 3D spatial understanding. Without explicit constraints about spatial relationships, it generates plausible-looking frames individually that violate physical continuity when played in sequence.

**Fixes:**
- **Minimize camera movement** — static or slow-panning cameras maintain spatial consistency far better than dynamic camera moves
- **Describe spatial relationships explicitly** — e.g., "the electrician stands 3 feet from the panel, facing it directly"
- **Avoid complex interactions with environment** — keep subjects separated from walls, furniture, and other objects
- **Use reference images (image-to-video)** — a starting frame anchors the scene geometry, preventing drift
- **Keep clips short** — 4-6 second clips have far fewer spatial violations than 8+ second clips

**Source:** [Genra.ai](https://genra.ai/blog/why-ai-videos-look-fake-how-to-fix)  
**Source:** [LTX Studio Blog — "Temporal Consistency In AI Video"](https://ltx.io/blog/temporal-consistency-in-ai-video) (May 2026)

### 1.2 Missing/Extra Fingers and Hand Distortion

**What it looks like:** Hands with 6+ fingers, fused digits, or hands that morph into tools or objects.

**Why it happens:** Hands are high-frequency, complex structures. The model's latent space struggles to maintain finger count across frames. The problem worsens with motion.

**Fixes:**
- **Keep hands out of frame** — frame shots from chest-up or wider to avoid hands entirely
- **If hands must appear, keep them static** — gripping a tool, resting on a surface
- **Use image-to-video with a clean reference frame** — generate a still image first (where hands are correct), then animate
- **Choose models with better hand generation** — Veo 3.1 and Sora 2 have significantly improved hand generation as of 2026, but the problem is not fully solved
- **Crop/zoom in post** — if a hand distortion appears in a corner, crop it out

**Source:** [Genra.ai](https://genra.ai/blog/why-ai-videos-look-fake-how-to-fix)  
**Source:** [aifruit.app](https://aifruit.app/blog/how-to-fix-ai-video-quality-issues)

### 1.3 Bad Edits / Jump Cuts

**What it looks like:** Sudden discontinuities — a character's clothing changes, objects teleport, lighting shifts abruptly mid-clip.

**Why it happens:** Multi-shot prompts without clear transition language cause the model to jump between scenes without coherent bridging. Models also struggle with the boundaries of clip-length segments.

**Fixes:**
- **Use single-shot compositions** — for 8-second clips, one continuous shot is ideal; avoid multi-shot prompts
- **If multiple shots are needed, use timestamp prompting** — Veo 3.1 supports `[00:00-00:04]` style timestamps (see §2.3)
- **Trim first and last 0.5 seconds** — AI video models produce the worst artifacts at clip boundaries; trimming these removes the worst flickering
- **Use "first and last frame" features** (Veo 3.1, Kling) — explicitly define start and end frames for controlled transitions

**Source:** [Google Cloud Blog — "Ultimate prompting guide for Veo 3.1"](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1) (October 2025)  
**Source:** [aifruit.app](https://aifruit.app/blog/how-to-fix-ai-video-quality-issues)

### 1.4 Unrealistic Physics

**What it looks like:** Objects fall too slowly, liquids behave incorrectly, materials pass through each other, gravity seems inconsistent.

**Why it happens:** AI models don't simulate physics — they predict pixel patterns based on training data. Without explicit physics description, the model applies "average" motion that looks weightless or floaty.

**Fixes:**
- **Describe physics explicitly in prompts** — instead of "a ball bounces," write "a rubber ball drops, compresses on impact, bounces back with decreasing height"
- **Use weight/mass language** — "heavy steel panel," "lightweight plastic cover"
- **Specify motion speed** — "slowly lifts," "rapidly snaps"
- **Avoid complex physical interactions** — pouring liquids, collapsing structures, cloth simulation are all high-failure-rate
- **For electrical content:** focus on static scenes (panel installation, tool close-ups) rather than dynamic actions (wire pulling, conduit bending)

**Source:** [Genra.ai](https://genra.ai/blog/why-ai-videos-look-fake-how-to-fix)

### 1.5 Text Hallucination (Garbled Words on Screen)

**What it looks like:** Text on signs, labels, screens, or documents appears as gibberish — letters morph, repeat, or blend into shapes. Brand names become unrecognizable.

**Why it happens:** Video models generate text at the pixel level without character-level understanding. Each frame may render text differently, causing flickering and morphing letters.

**Fixes:**
- **Avoid text in prompts entirely** — do not ask for text on signs, screens, or labels in the generated video
- **Add text overlays in post-production** — use FFmpeg, CapCut, or similar tools to burn in clean, crisp text after generation
- **If text must appear in-scene, keep it static and large** — large, simple text on a plain background has the best chance of rendering correctly
- **Use image-to-video** — generate a still image with correct text (using a text-capable image model like GPT Image 2 or Gemini 2.5 Flash Image), then animate it
- **2026 models with better text rendering:** Google's Omni/Veo 3.1 has improved on-screen text, but it is still unreliable for brand names

**Source:** [Genra.ai — Problem 7: Text and Logo Distortion](https://genra.ai/blog/why-ai-videos-look-fake-how-to-fix)  
**Source:** [Framia by Converge AI — Google Omni](https://framia.converge.ai/models/google-omni/)

### 1.6 Uncanny Valley Faces

**What it looks like:** Faces that are almost human but subtly "off" — dead eyes, unnatural skin texture, asymmetric features, or faces that "melt" during movement.

**Why it happens:** Models generate each frame semi-independently. Without strong identity constraints, the model makes different probabilistic choices frame-to-frame, causing features to drift. The "AI aesthetic" also tends toward over-smoothed, plasticky skin.

**Fixes:**
- **Use reference images** — provide a clear character reference image to anchor identity
- **Reduce camera movement** — static or slow-moving cameras maintain face consistency
- **Limit face time** — cut away from faces during dynamic scenes; show hands, tools, or environment instead
- **Choose the right model** — Kling AI and Runway excel at human face consistency; Veo 3.1 has lifelike lip-sync
- **If a face looks good in frame 1, use that frame as a reference for regeneration**
- **For marketing content, consider showing the work, not the worker** — close-ups of panels, tools, and installations avoid the face problem entirely

**Source:** [Genra.ai](https://genra.ai/blog/why-ai-videos-look-fake-how-to-fix)  
**Source:** [aifruit.app — Face morphing](https://aifruit.app/blog/how-to-fix-ai-video-quality-issues)

### 1.7 Temporal Inconsistency (Objects Appearing/Disappearing)

**What it looks like:** Objects appear, disappear, or transform between frames. A tool on a bench vanishes, a wall changes color, a wire appears from nowhere.

**Why it happens:** This is the core challenge of AI video — temporal consistency. Models generate frames semi-independently, and without explicit constraints, object permanence is not maintained. This is called "temporal drift."

**Fixes:**
- **Keep scenes simple** — fewer objects = fewer opportunities for drift
- **Specify what should NOT change** — e.g., "the toolbox remains on the left side of the bench throughout"
- **Use shorter clips** — 4-6 second clips maintain consistency far more reliably than 8+ second clips
- **Use image-to-video** — starting from a reference image anchors object positions
- **Specify "consistent lighting" and "smooth continuous motion"** in the prompt
- **Use "ingredients to video" (Veo 3.1)** — provide reference images of objects to maintain consistency across shots

**Source:** [iMerit — "Temporal Drift in AI-Generated Video: Causes, Evaluation, and Production Strategies"](https://imerit.ai/resources/blog/solving-temporal-drift-in-ai-generated-video/) (March 2026)  
**Source:** [LTX Studio — "Temporal Consistency In AI Video"](https://ltx.io/blog/temporal-consistency-in-ai-video) (May 2026)  
**Source:** [aifruit.app](https://aifruit.app/blog/how-to-fix-ai-video-quality-issues)

---

## 2. Prompt Engineering Techniques for Video Generation

### 2.1 How to Structure Prompts for Maximum Realism

The most effective prompt structure follows a **five-part formula**:

```
[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]
```

- **Cinematography:** Camera work and shot composition (e.g., "Medium shot, slow dolly-in")
- **Subject:** Main character or focal point (e.g., "a licensed electrician in a blue uniform")
- **Action:** What the subject is doing (e.g., "installing a circuit breaker panel")
- **Context:** Environment and background (e.g., "in a modern residential garage with drywall walls")
- **Style & ambiance:** Aesthetic, mood, and lighting (e.g., "documentary realism, natural daylight from a side window, 4K quality")

**Example prompt for electrical marketing:**
> Medium shot, slow dolly-in, a licensed electrician in a clean blue uniform, carefully aligning a new circuit breaker panel, in a modern residential utility room with white drywall walls and concrete floor, documentary realism style, natural daylight from a side window, consistent lighting, smooth continuous motion, photorealistic, 4K.

**Source:** [Google Cloud Blog — Veo 3.1 Prompting Guide](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1) (October 2025)  
**Source:** [Truefan.ai — "Master cinematic AI video prompts: 2026 expert playbook"](https://www.truefan.ai/blogs/cinematic-ai-video-prompts-2026)  
**Source:** [Digen.ai — "Text to Video AI Prompt Guide: Master Cinematic AI in 2026"](https://resource.digen.ai/text-to-video-ai-prompt-guide/)

### 2.2 Camera Direction Language That Models Understand

Models trained on film/video data respond well to professional cinematography terms:

| Term | Effect |
|------|--------|
| `dolly shot` | Smooth forward/backward camera movement |
| `tracking shot` | Camera follows subject laterally |
| `crane shot` | Vertical camera movement (up/down) |
| `slow pan` | Horizontal camera rotation |
| `POV shot` | First-person perspective |
| `wide shot` | Full scene visible |
| `close-up` / `extreme close-up` | Tight framing on subject/detail |
| `low angle` | Camera looking up at subject |
| `shallow depth of field` | Blurred background, sharp subject |
| `wide-angle lens` | Expanded field of view |
| `static shot` | No camera movement (best for consistency) |

**For 8-second marketing clips:** Use `static shot` or `slow dolly-in` for maximum consistency. Avoid `crane shot`, `aerial view`, or complex multi-axis movements.

**Source:** [Google Cloud Blog — Veo 3.1 Prompting Guide](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1)  
**Source:** [Medium — "How to Actually Control Next-Gen Video AI"](https://medium.com/@creativeaininja/how-to-actually-control-next-gen-video-ai-runway-kling-veo-and-sora-prompting-strategies-92ef0055658b) (December 2025)

### 2.3 Duration/Scene Count Optimization

**Key principle: One shot per clip.** For 8-second videos, a single continuous shot produces the fewest artifacts.

- **0 cuts = best consistency** — a single unbroken shot avoids all transition artifacts
- **2 cuts max for 8 seconds** — if multiple shots are needed, use timestamp prompting (see below)
- **Veo 3.1 timestamp prompting example:**

```
[00:00-00:04] Medium shot of an electrician opening a panel cover with a screwdriver.
[00:04-00:08] Close-up of the electrician's hands connecting a wire to a breaker.
```

- **Do not exceed 2 timestamp segments in 8 seconds** — rapid cuts amplify temporal inconsistency

**Source:** [Google Cloud Blog — Veo 3.1 Workflow 3: Timestamp prompting](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1)

### 2.4 Negative Prompts

Negative prompt support varies by model:

| Model | Negative Prompt Support | Notes |
|-------|------------------------|-------|
| **Veo 3.1** | ✅ (via descriptive exclusion) | Google recommends phrasing exclusions positively: "a desolate landscape with no buildings or roads" instead of "no man-made structures" |
| **Runway Gen-3/Gen-4** | ✅ | Dedicated negative prompt field |
| **Kling 2.0/3.0** | ✅ | Supports negative prompts |
| **Sora 2** | ❌ (limited) | Relies on prompt specificity |
| **Grok Imagine** | ❌ | No explicit negative prompt; use descriptive constraints |

**Best practice for all models:** Instead of relying on negative prompts, write highly specific positive descriptions that leave no room for unwanted elements. E.g., instead of "no text, no signs, no watermarks," describe a scene where those elements wouldn't naturally appear.

**Source:** [Google Cloud Blog — Veo 3.1 "Mastering negative prompts"](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1)  
**Source:** [Grokipedia — "Prompt engineering for AI video generators"](https://grokipedia.com/page/Prompt_engineering_for_AI_video_generators) (March 2026)

### 2.5 Reference Image Usage (Image-to-Video for Consistency)

Image-to-video is the **single most effective technique** for reducing AI video artifacts. A reference image anchors:
- Character identity (prevents face morphing)
- Object positions (prevents temporal drift)
- Scene geometry (prevents morphing/walking through walls)
- Lighting and color palette (prevents flicker)

**Workflow recommendation for this pipeline:**
1. Generate a high-quality still image using a text-to-image model (FLUX, DALL-E, Midjourney)
2. Verify the image has no artifacts (correct hands, no garbled text, proper proportions)
3. Use that image as the first frame for video generation
4. This "clean frame" approach eliminates 60-80% of common video artifacts

**Advanced: "Ingredients to Video" (Veo 3.1)** — Provide multiple reference images (character + setting + object) to maintain consistency across multiple shots.

**Source:** [Google Cloud Blog — Veo 3.1 "Consistent elements with ingredients to video"](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1)  
**Source:** [Cliprise.app — "Image Reference Upload: Significantly Improve AI Video Consistency"](https://www.cliprise.app/learn/guides/best-practices/image-reference-upload-ai-video-consistency)  
**Source:** [aividpipeline.com — "Character Consistency in AI Video"](https://aividpipeline.com/blog/character-consistency-ai-video) (February 2026)

### 2.6 Seed Control for Reproducibility

Seed control allows you to reproduce or iterate on a specific generation:

| Model | Seed Control | Notes |
|-------|-------------|-------|
| **Veo 3.1** | ✅ | Via API on Vertex AI |
| **Runway Gen-4** | ✅ | Seed parameter available |
| **Kling 2.0/3.0** | ✅ | Seed parameter in API |
| **Grok Imagine (xAI)** | ✅ | Seed exposed in API |
| **Sora 2** | Limited | Not fully exposed |
| **Seedance 2.0** | ❌ | Does not expose seed control |

**Best practice:** Log the seed value for every generation. When you get a good result, you can reproduce it and make incremental prompt changes to iterate without starting from scratch.

**Source:** [Vidau.ai — "Seedance 2.0: The Best Breakdown of Hype VS Real Life"](https://www.vidau.ai/seedance-2-0-the-best-breakdown-of-hype-vs-real-life-for-creators-now/)  
**Source:** [Qubittool.com — "AI Video Generation [2026]: Veo 3 & Kling 2.0 API Guide"](https://qubittool.com/blog/ai-video-generation-engineering-veo3-kling)

---

## 3. Post-Processing Techniques to Improve Quality

### 3.1 FFmpeg Filters for AI Video Cleanup

AI-generated videos benefit from a specific post-processing chain. The recommended order (violating this order causes artifacts):

```
1. Temporal denoise  → remove inter-frame shimmer
2. Scale             → scale before sharpening to avoid halos
3. Sharpen           → recover edge detail lost in generation
4. Color grade (LUT) → normalize over-saturated AI palette
5. Curves/EQ         → fine-tune contrast and shadow lift
6. Film grain        → add LAST before encode; grain before denoising destroys it
7. Encode            → libx265 -tune grain or AV1
```

**Production-ready FFmpeg command:**

```bash
ffmpeg -i input.mp4 \
  -vf "hqdn3d=2:2:3:3,\
scale=1920:1080:flags=lanczos,\
unsharp=5:5:0.8:5:5:0.4,\
lut3d=grade.cube,\
curves=r='0/0 0.5/0.52 1/1':b='0/0.03 1/0.97',\
noise=alls=6:allf=t+u" \
  -c:v libx265 -crf 18 -preset slow -tune grain \
  -c:a copy output.mp4
```

**Key filters explained:**
- `hqdn3d` — High-quality 3D denoise; smooths inter-frame flicker without destroying detail. Values 2:2:3:3 are conservative.
- `unsharp` — Restores edge sharpness lost during AI generation. Keep amounts low (0.4-0.8) to avoid halos.
- `lut3d` — Apply a color grading LUT to normalize the typically over-saturated AI color palette.
- `curves` — Adjust contrast; slight shadow lift makes AI video look less "flat."
- `noise=alls=6` — Subtle film grain (applied LAST) masks remaining AI artifacts and adds organic texture.

**Source:** [Claude Plugin Hub — ffmpeg-production skill](https://www.claudepluginhub.com/skills/galbaz1-gr/ffmpeg-production) (May 2026)  
**Source:** [ReelMind — "FFmpeg AI Enhancement: Next-Level Command Line Video Processing Techniques"](https://reelmind.ai/blog/ffmpeg-ai-enhancement-next-level-command-line-video-processing-techniques) (May 2025)

### 3.2 Frame Interpolation for Smoother Motion

AI videos are often generated at 24fps, which can look choppy. Frame interpolation adds intermediate frames for smoother playback.

**RIFE (Real-Time Intermediate Flow Estimation):**
- AI-based interpolation that computes optical flow between frames and synthesizes genuine intermediates
- Can convert 24fps → 60fps for buttery smooth motion
- Open-source implementations: [Flowframes](https://flowframes.app/) (Windows GUI), [rife-ncnn-vulkan](https://github.com/topics/frame-interpolation) (CLI)

**FFmpeg minterpolate (basic, no AI):**
```bash
ffmpeg -i input.mp4 -vf "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1" output_60fps.mp4
```
Note: `minterpolate` is lower quality than RIFE but requires no GPU/AI model.

**When to use interpolation:**
- ✅ Smooth slow-motion effects
- ✅ Reduce judder in panning shots
- ✅ Fix minor frame-to-frame inconsistency
- ❌ Does NOT fix major temporal inconsistency (objects appearing/disappearing)
- ❌ Can introduce tearing if applied after film grain

**Source:** [Hedra Blog — "How to Fix (Or Better Yet Avoid) Glitchy AI Video"](https://www.hedra.com/blog/how-to-fix-glitchy-ai-video-consistency-upscaling) (December 2025)  
**Source:** [Flowframes](https://flowframes.app/)  
**Source:** [CloudACM — "FFMpeg Time Lapse and Slow Motion"](https://www.cloudacm.com/?p=3055)

### 3.3 Color Grading

AI videos tend to have an over-saturated, slightly plastic look. Color grading normalizes this:

- **Apply a LUT (Look-Up Table)** — use FFmpeg `lut3d` filter or DaVinci Resolve
- **Desaturate slightly** — AI video often pushes saturation 10-15% too high
- **Add warm shadows** — AI video tends toward cool/flat shadows; lifting shadows toward warm tones adds realism
- **Slight contrast boost** — AI video can look flat; a gentle S-curve adds depth

**FFmpeg LUT application:**
```bash
ffmpeg -i input.mp4 -vf "lut3d=custom_grade.cube" -c:a copy output_graded.mp4
```

**Source:** [Claude Plugin Hub — ffmpeg-production](https://www.claudepluginhub.com/skills/galbaz1-gr/ffmpeg-production)

### 3.4 Audio Synchronization

If generating audio separately from video:
- **Veo 3.1 generates synchronized audio natively** — no sync needed
- **For externally generated audio**, use FFmpeg to merge:
```bash
ffmpeg -i video.mp4 -i audio.mp3 -c:v copy -c:a aac -shortest output.mp4
```
- **Ensure audio duration matches video** — `-shortest` flag trims to the shorter stream
- **For Reels:** Add a "whoosh" or "pop" sound effect at the 0.5-second mark to reinforce the visual hook

### 3.5 Cut Optimization

- **Trim first and last 0.5 seconds** — AI video artifacts are worst at clip boundaries:
```bash
ffmpeg -i input.mp4 -ss 0.5 -to $(($(ffprobe -v error -show_entries format=duration -of csv=p=0 input.mp4 | cut -d. -f1) - 1)) -c copy output_trimmed.mp4
```
- **Cross-fade between clips** (if combining multiple generations):
```bash
ffmpeg -i clip1.mp4 -i clip2.mp4 -filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=7.5" output.mp4
```

**Source:** [aifruit.app — "Trimming the first and last 0.5 seconds removes the worst flickering"](https://aifruit.app/blog/how-to-fix-ai-video-quality-issues)

---

## 4. Model-Specific Quality Tips

### 4.1 Grok Imagine (xAI)

**Strengths:** Speed, integration with X platform, image-to-video via Aurora motion engine  
**Weaknesses:** Less control than Veo/Runway, no negative prompts, limited duration control  

**Best practices:**
- Use **image-to-video** mode for best results — generate a still image first, then animate
- Grok Imagine excels at **short, dynamic clips** (4-8 seconds)
- Keep prompts **simple and visual** — complex narrative prompts don't translate well
- Native sound generation is available — describe desired audio in the prompt
- For marketing: use Grok Imagine for quick iteration, then re-generate the best concept with a higher-fidelity model

**Source:** [ExpertBeacon — "How to Use Grok Imagine for AI Images & Videos"](https://expertbeacon.com/how-to-use-grok-imagine-for-ai-images-videos/) (December 2025)  
**Source:** [DzinePixel — "Grok Imagine: Your 2025 Guide to Making Short AI Videos"](https://www.dzinepixel.com/blog/grok-imagine-your-2025-guide-to-making-short-ai-videos-explained-simply/) (October 2025)  
**Source:** [Picassoia — "Grok Imagine Video: How to Make AI Videos with xAI"](https://blog.picassoia.com/grok-imagine-video-how-to-make-ai-videos-with-xai) (April 2026)

### 4.2 Google Veo 3 / 3.1

**Strengths:** Best-in-class prompt adherence, native audio, 9:16 vertical, first/last frame control, ingredients-to-video, timestamp prompting  
**Weaknesses:** Higher cost, longer generation time  

**Best practices:**
- Use the **five-part formula**: `[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]`
- **9:16 vertical is natively supported** — no letterboxing needed
- **Clip lengths: 4, 6, or 8 seconds** — 8 seconds is the maximum
- Use **timestamp prompting** for multi-shot sequences within a single generation
- Use **"first and last frame"** for controlled transitions
- Use **"ingredients to video"** for character/object consistency across multiple shots
- Describe audio in the prompt: `SFX:`, `Ambient noise:`, and quoted dialogue
- **Negative prompts:** phrase positively ("a landscape with no buildings" not "no buildings")
- Veo 3.1 is the **recommended model for this pipeline** given its native 9:16 support, 8-second clip length, and audio generation

**Source:** [Google Cloud Blog — "Ultimate prompting guide for Veo 3.1"](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1) (October 2025)  
**Source:** [Google DeepMind — Veo 3.1 model page](https://deepmind.google/models/veo/)  
**Source:** [Google DeepMind — "How to create effective prompts with Veo 3"](https://deepmind.google/models/veo/prompt-guide/)

### 4.3 Sora 2 (OpenAI)

**Strengths:** Up to 25-second clips, synchronized audio, strong physics understanding  
**Weaknesses:** Limited availability, Sora product was shut down/restructured in 2026, less control than Veo  

**Best practices:**
- Sora 2 handles **longer clips** better than most models (up to 25 seconds)
- Strong at **physics simulation** — less floaty movement than earlier models
- Use **structured prompts** with clear temporal sequencing
- No explicit negative prompt support — rely on specificity
- **Note:** As of mid-2026, Sora's availability is uncertain. Check current status before relying on it for production pipelines.

**Source:** [ExplainX — "AI Video Generation 2026: Sora, Runway, Kling Complete Guide"](https://www.explainx.ai/blog/video-generation-ai-sora-runway-kling-complete-guide-2026)  
**Source:** [AIUnpacking — "AI Video Generation 2026: Sora, Runway, Kling, Veo, and Creator"](https://aiunpacking.com/guides/ai-video-generation-sora-runway-kling-veo/)

### 4.4 Runway (Gen-3 Alpha / Gen-4)

**Strengths:** Fastest generation speed, motion brush control, excellent face consistency, video-to-video  
**Weaknesses:** Shorter max clip lengths, less audio capability  

**Best practices:**
- **Upload a reference image** as the starting frame for best results
- Use **Motion Brush** to control which parts of the image move (and which stay static)
- Runway excels at **human face consistency** — good for contractor/worker shots
- Gen-4 is the **fastest** model — good for rapid iteration
- Use **video-to-video** to restyle existing footage (e.g., turn a real electrical video into a stylized version)
- Supports **negative prompts** — use them to exclude unwanted elements

**Source:** [Runway Research — "Introducing Gen-3 Alpha"](https://runwayml.com/research/introducing-gen-3-alpha)  
**Source:** [RunComfy — "Runway Gen-3 Alpha Best Practices"](https://www.runcomfy.com/models/runwayml/runway-gen-3-alpha-turbo)

### 4.5 Kling AI (2.0 / 3.0)

**Strengths:** Native 4K/60fps output (3.0), character consistency via Elements 3.0, 15-second sequences, strong face generation  
**Weaknesses:** Less known in Western markets, API access can be less straightforward  

**Best practices:**
- Kling 3.0 supports **native 4K at 60fps** — highest resolution of any model
- Use **Elements 3.0** for character consistency across multiple shots
- Kling excels at **realistic, live-action-style** content without needing stylization overrides
- Prompt with **detailed real-world scene descriptions, camera dynamics, and lighting cues**
- Best for **cinematic, high-fidelity** marketing content
- 15-second max clip length is the longest among top models

**Source:** [Kling.ai — "How to Choose the Best AI Video Generator of 2026"](https://kling.ai/blog/best-ai-video-generator-2026-kling-ai)  
**Source:** [Grokipedia — "Prompt engineering for AI video generators"](https://grokipedia.com/page/Prompt_engineering_for_AI_video_generators) (March 2026)  
**Source:** [KidNihon — "AI Video Generation in 2026: Sora 2, Runway Gen-4, Kling 3.0 & Veo 3.1"](https://kidnihon.com/en/technology/ai-video-generation-in-2026-sora-2-runway-gen-4-kling-30-veo-31---full-comparison)

---

## 5. Quality Verification Approaches

### 5.1 Programmatic AI Video Artifact Detection

**Skyra (CVPR 2026):**
A specialized multimodal LLM that identifies human-perceivable visual artifacts in AI-generated videos. It can detect and explain artifacts with grounded evidence.

- **BrokenVideos benchmark:** 3,254 AI-generated videos with pixel-level masks highlighting regions of visual corruption, validated through human inspection
- Can be used as an automated quality gate in a production pipeline

**NVIDIA Research (2025):**
Published research on detecting artifacts in clean and corrupted video pairs, identifying artifact types that influence human perception of quality.

**Practical programmatic checks for a pipeline:**
1. **Frame-difference analysis** — compute per-pixel frame-to-frame differences; spikes indicate temporal discontinuities
2. **Optical flow consistency** — large flow vectors in static regions indicate morphing
3. **SSIM (Structural Similarity Index)** — compare consecutive frames; low SSIM in static scenes indicates flickering
4. **Face detection + landmark tracking** — track facial landmarks across frames; large jitter indicates face morphing
5. **Edge detection consistency** — sudden appearance/disappearance of edges indicates object drift

**Source:** [ArXiv — "BrokenVideos: A Benchmark Dataset for Fine-Grained Video Artifact Localization"](https://arxiv.org/abs/2506.20103) (June 2025)  
**Source:** [Skyra project page](https://joeleelyf.github.io/Skyra/)  
**Source:** [NVIDIA Research — "Detection of artifacts in clean and corrupted video pairs"](https://research.nvidia.com/publication/2025-05_detection-artifacts-clean-and-corrupted-video-pairs-influenced-artifact-type)

### 5.2 Human Review Checklist

For each generated video, a reviewer should check:

**Spatial Consistency:**
- [ ] No characters or objects pass through walls/surfaces
- [ ] Scene geometry remains stable throughout (no morphing walls/floors)
- [ ] Objects don't appear or disappear between frames

**Body/Hand Integrity:**
- [ ] All hands have exactly 5 fingers (or are obscured)
- [ ] No body parts merge with objects or environment
- [ ] Limbs maintain consistent proportions

**Face Quality:**
- [ ] Face features remain stable (no melting, drifting, or asymmetry)
- [ ] Eyes look natural (not dead/staring)
- [ ] Skin texture looks realistic (not plastic/waxy)

**Lighting/Color:**
- [ ] No flickering or sudden exposure shifts
- [ ] Color palette remains consistent throughout
- [ ] Shadows match light sources

**Text/Logos:**
- [ ] No garbled text appears on screen
- [ ] Brand logos (if any) are legible
- [ ] No hallucinated text on signs/labels/screens

**Motion:**
- [ ] Movement feels grounded (not floaty)
- [ ] Physics appear plausible (gravity, weight, momentum)
- [ ] No sudden jump cuts or discontinuities

**Audio (if applicable):**
- [ ] Audio is synchronized with visual events
- [ ] No artifacts in dialogue
- [ ] Sound effects match on-screen actions

**Source:** [iMerit — "Temporal Drift in AI-Generated Video"](https://imerit.ai/resources/blog/solving-temporal-drift-in-ai-generated-video/) (March 2026)  
**Source:** [Genra.ai](https://genra.ai/blog/why-ai-videos-look-fake-how-to-fix)

### 5.3 A/B Testing Approaches for Social Media Video

**Approach:**
1. **Generate 3-5 variants** of each video concept (different seeds, slight prompt variations)
2. **Human review filters to top 2** using the checklist above
3. **Publish both as separate Reels** with identical captions/timing
4. **Track metrics for 72 hours:**
   - 3-second hold rate (most critical)
   - Completion rate
   - Share rate
   - Comment rate
   - Click-through rate (if linked)

**Key metrics for short-form video:**
- **3-second hold rate** — if viewers don't hold past 3 seconds, the video fails regardless of other metrics
- **Completion rate** — videos under 15 seconds should achieve 50%+ completion
- **Share rate** — the strongest signal of content quality

**Testing cadence:** Test 2 variants per week per content theme. After 4-6 weeks, identify patterns in which prompt structures/styles perform best.

**Source:** [Vizard — "A/B Testing Social Media Videos: A Comprehensive Guide"](https://vizard.ai/knowledge-base/social-media-growth/a-b-testing-social-media-videos) (May 2025)  
**Source:** [SocialInsider — "Social Media A/B Testing: How to Do It and Best Practices"](https://www.socialinsider.io/blog/ab-testing-social-media/) (February 2025)  
**Source:** [ReelMind — "The Social Media Video A/B Tester AI"](https://reelmind.ai/blog/the-social-media-video-a-b-tester-ai-that-helps-you-optimize-content-for-maximum-engagement)

---

## 6. Facebook Reel-Specific Optimization

### 6.1 Optimal Duration for Engagement

For short-form vertical video on Meta platforms (Facebook/Instagram Reels):

| Duration | Completion Rate | Best For |
|----------|----------------|----------|
| 7-15 seconds | ~57% | Quick engagement, hooks, brand awareness |
| 15-30 seconds | ~45% | Product demos, mini-tutorials |
| 30-60 seconds | ~36% | Storytelling, detailed explanations |

**Recommendation for this pipeline:** The current 8-second duration is **optimal** — it sits in the 7-15 second "sweet spot" with the highest completion rates and shareability. Do not lengthen videos beyond 10 seconds without a compelling reason.

**Source:** [LinkedIn — "Instagram Reels Length Guide 2025: Best Practices for Engagement"](https://www.linkedin.com/pulse/instagram-reels-length-guide-2025-best-practices-amuwe) (April 2025)  
**Source:** [OneStream — "How Long Can Instagram Reels Be in 2025?"](https://onestream.live/blog/how-long-can-instagram-reels-be/) (August 2025)  
**Source:** [BigMotion AI — "What Is the Best Length for Instagram Reels in 2025?"](https://www.bigmotion.ai/blog/what-is-the-best-length-for-instagram-reels-in-2025) (July 2025)

### 6.2 First-Second Hook Importance

Meta's own research emphasizes that the **first 1-3 seconds** determine whether a user scrolls past or watches to completion.

**Meta's hook recommendations:**
- Use **both visual elements AND sound** to deliver the hook — this boosts purchase intent likelihood by 1.5x
- Three hook approaches that work:
  1. **Value promise** — "Here's what your electrician doesn't want you to know..."
  2. **Statement of intent** — "Watch this panel upgrade in 8 seconds"
  3. **Question/invitation** — "Is your electrical panel this old?"

**For AI-generated electrical content:**
- The first frame should be visually striking — a close-up of a panel, sparks, or a dramatic before/after
- Avoid starting with faces (uncanny valley risk in the first second causes immediate scroll)
- Start with **motion** — a tool being picked up, a panel door opening

**Source:** [Meta for Business — "The Science of the Hook: How to Supercharge Your Reels Performance"](https://business.facebook.com/business/news/the-science-of-the-hook-how-to-supercharge-your-reels-performance/)  
**Source:** [Opus.pro — "Facebook Reels Hook Formulas That Drive 3-Second Holds"](https://www.opus.pro/blog/facebook-reels-hook-formulas) (November 2025)

### 6.3 Audio Design for Reels

Meta's research (Toluna study, December 2025) found:

- Using **both speech AND music together** makes creatives **2.0x more likely** to rank in the top 20% for brand interest
- Delivering the message through **both audio AND visual cues** increases brand interest likelihood by **1.8x**
- Audio is not optional — silent-video performance is significantly worse on Reels

**Recommendations for AI video:**
- **Use Veo 3.1's native audio generation** — it can generate synchronized SFX, ambient noise, and dialogue
- If using external audio: add a trending music track + voiceover
- **Sound design template for electrical Reels:**
  - 0-1s: "Whoosh" or "pop" sound effect (hook reinforcement)
  - 1-6s: Ambient electrical hum + subtle background music
  - 6-8s: Satisfying "click" or "snap" (breaker switching, panel closing)

**Source:** [Meta for Business — "Deconstructing the Power of Reels: How Creative Strategies Can Drive Success"](https://www.facebook.com/business/news/reels-creative-strategies/) (December 2025)  
**Source:** [SocialMediaToday — "Meta Shares Updated Reels Ads Guide"](https://www.socialmediatoday.com/news/meta-publishes-reels-ads-guide-instagram-facebook-video-marketing/752771/) (July 2025)

### 6.4 Caption/Text Overlay Best Practices

**Critical:** Do NOT rely on AI video models to generate text in-video. Add all text as overlays in post-production.

**Meta's research findings:**
- Showing **brand and main message within the first 5 seconds** makes creatives **1.7x more likely** to rank in the top 20%
- **Dynamic branding** (brand appears more than once) increases purchase intent likelihood by **1.8x**
- Using **emojis as native elements** makes creatives **2.5x more likely** to rank in the top 20%
- Including a **CTA** (visual and/or audio) increases purchase intent likelihood by **1.9x**

**Technical overlay implementation (FFmpeg):**
```bash
# Add a text overlay at the bottom
ffmpeg -i input.mp4 -vf "drawtext=text='Licensed Electricians':fontcolor=white:fontsize=48:box=1:boxcolor=black@0.5:boxborderw=10:x=(w-text_w)/2:y=h-text_h-50" -c:a copy output_captioned.mp4

# Add brand logo watermark
ffmpeg -i input.mp4 -i logo.png -filter_complex "[0:v][1:v]overlay=10:10" -c:a copy output_branded.mp4
```

**Caption best practices for Reels:**
- Use large, bold text (minimum 48px equivalent at 1080x1920)
- Place text in the center-safe zone (avoid top/bottom 15% where UI elements appear)
- Keep text on-screen for 2-3 seconds per phrase
- Use high-contrast colors (white text on dark background, or vice versa)
- Maximum 5-7 words per overlay

**Source:** [Meta for Business — Reels Creative Strategies](https://www.facebook.com/business/news/reels-creative-strategies/) (December 2025)  
**Source:** [Amplitude Marketing — "How to Create Facebook Reels That Attract an Audience in 2025"](https://amplitudemktg.com/social-media/how-to-create-facebook-reels-that-attract-an-audience-in-2025/) (February 2025)

---

## 7. Actionable Recommendations for This Pipeline

Based on all research above, here are the specific changes to implement for the electrical services marketing video pipeline:

### Immediate Changes (High Impact, Low Effort)

1. **Switch to image-to-video workflow:**
   - Generate a clean still image first (using FLUX or similar)
   - Verify no artifacts (hands, text, proportions)
   - Use that image as the first frame for video generation
   - Expected artifact reduction: 60-80%

2. **Restructure prompts using the five-part formula:**
   ```
   [Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]
   ```
   Example: "Static shot, close-up of a licensed electrician's hands installing a circuit breaker, in a modern residential utility room, documentary realism, natural daylight, consistent lighting, smooth continuous motion, photorealistic, 4K"

3. **Keep prompts to a single shot per clip** — no multi-shot or timestamp segments for 8-second videos

4. **Add post-processing chain:**
   - Trim first/last 0.5 seconds
   - Apply `hqdn3d` denoise + `unsharp` sharpening
   - Add subtle film grain
   - Add text overlays in post (never in-generation)

5. **Avoid faces** — show hands, tools, panels, and environments instead of faces to avoid uncanny valley

### Medium-Term Changes (High Impact, Moderate Effort)

6. **Switch to Veo 3.1** as primary model — native 9:16, 8-second clips, audio generation, best prompt adherence
7. **Log seeds** for all generations for reproducibility and iteration
8. **Implement automated quality checks:**
   - Frame-difference analysis for temporal consistency
   - SSIM check for flickering
   - Face landmark tracking for morphing detection
9. **Implement human review checklist** before publishing any video
10. **Generate 3 variants per concept** and A/B test the top 2

### Long-Term Changes (Strategic)

11. **Build a reference image library** — clean, verified images of electrical scenes to use as I2V starting frames
12. **Explore Veo 3.1 "ingredients to video"** for multi-shot consistency
13. **Develop prompt templates** per content type (panel upgrade, inspection, emergency repair, etc.)
14. **Implement audio design templates** — standardized SFX + music tracks per content type

---

## Source Index

| # | Source | URL | Date |
|---|--------|-----|------|
| 1 | Genra.ai — 7 Fixes for AI Video Artifacts | https://genra.ai/blog/why-ai-videos-look-fake-how-to-fix | Feb 2026 |
| 2 | aifruit.app — How to Fix AI Video Quality Issues | https://aifruit.app/blog/how-to-fix-ai-video-quality-issues | May 2026 |
| 3 | Google Cloud Blog — Veo 3.1 Prompting Guide | https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1 | Oct 2025 |
| 4 | Google DeepMind — Veo 3.1 Model Page | https://deepmind.google/models/veo/ | 2025 |
| 5 | Google DeepMind — Veo 3 Prompt Guide | https://deepmind.google/models/veo/prompt-guide/ | 2025 |
| 6 | iMerit — Temporal Drift in AI Video | https://imerit.ai/resources/blog/solving-temporal-drift-in-ai-generated-video/ | Mar 2026 |
| 7 | LTX Studio — Temporal Consistency in AI Video | https://ltx.io/blog/temporal-consistency-in-ai-video | May 2026 |
| 8 | Hedra Blog — Fix Glitchy AI Video | https://www.hedra.com/blog/how-to-fix-glitchy-ai-video-consistency-upscaling | Dec 2025 |
| 9 | Medium — How to Control Next-Gen Video AI | https://medium.com/@creativeaininja/how-to-actually-control-next-gen-video-ai-runway-kling-veo-and-sora-prompting-strategies-92ef0055658b | Dec 2025 |
| 10 | Truefan.ai — Cinematic AI Video Prompts 2026 | https://www.truefan.ai/blogs/cinematic-ai-video-prompts-2026 | 2026 |
| 11 | Digen.ai — Text to Video AI Prompt Guide | https://resource.digen.ai/text-to-video-ai-prompt-guide/ | May 2026 |
| 12 | Grokipedia — Prompt Engineering for AI Video | https://grokipedia.com/page/Prompt_engineering_for_AI_video_generators | Mar 2026 |
| 13 | ExpertBeacon — How to Use Grok Imagine | https://expertbeacon.com/how-to-use-grok-imagine-for-ai-images-videos/ | Dec 2025 |
| 14 | Picassoia — Grok Imagine Video Guide | https://blog.picassoia.com/grok-imagine-video-how-to-make-ai-videos-with-xai | Apr 2026 |
| 15 | DzinePixel — Grok Imagine 2025 Guide | https://www.dzinepixel.com/blog/grok-imagine-your-2025-guide-to-making-short-ai-videos-explained-simply/ | Oct 2025 |
| 16 | Runway Research — Gen-3 Alpha | https://runwayml.com/research/introducing-gen-3-alpha | 2025 |
| 17 | RunComfy — Runway Gen-3 Best Practices | https://www.runcomfy.com/models/runwayml/runway-gen-3-alpha-turbo | 2025 |
| 18 | Kling.ai — Best AI Video Generator 2026 | https://kling.ai/blog/best-ai-video-generator-2026-kling-ai | 2026 |
| 19 | KidNihon — AI Video Generation 2026 Comparison | https://kidnihon.com/en/technology/ai-video-generation-in-2026-sora-2-runway-gen-4-kling-30-veo-31---full-comparison | 2026 |
| 20 | ExplainX — AI Video Generation 2026 Guide | https://www.explainx.ai/blog/video-generation-ai-sora-runway-kling-complete-guide-2026 | 2026 |
| 21 | AIUnpacking — AI Video Generation Guide | https://aiunpacking.com/guides/ai-video-generation-sora-runway-kling-veo/ | May 2026 |
| 22 | Qubittool — AI Video Generation Engineering Guide | https://qubittool.com/blog/ai-video-generation-engineering-veo3-kling | 2026 |
| 23 | ArXiv — BrokenVideos Benchmark | https://arxiv.org/abs/2506.20103 | Jun 2025 |
| 24 | Skyra Project Page | https://joeleelyf.github.io/Skyra/ | 2025 |
| 25 | NVIDIA Research — Artifact Detection | https://research.nvidia.com/publication/2025-05_detection-artifacts-clean-and-corrupted-video-pairs-influenced-artifact-type | May 2025 |
| 26 | Meta for Business — Reels Creative Strategies | https://www.facebook.com/business/news/reels-creative-strategies/ | Dec 2025 |
| 27 | Meta for Business — Science of the Hook | https://business.facebook.com/business/news/the-science-of-the-hook-how-to-supercharge-your-reels-performance/ | 2025 |
| 28 | Opus.pro — Facebook Reels Hook Formulas | https://www.opus.pro/blog/facebook-reels-hook-formulas | Nov 2025 |
| 29 | SocialMediaToday — Meta Reels Ads Guide | https://www.socialmediatoday.com/news/meta-publishes-reels-ads-guide-instagram-facebook-video-marketing/752771/ | Jul 2025 |
| 30 | LinkedIn — Reels Length Guide 2025 | https://www.linkedin.com/pulse/instagram-reels-length-guide-2025-best-practices-amuwe | Apr 2025 |
| 31 | OneStream — How Long Can Reels Be | https://onestream.live/blog/how-long-can-instagram-reels-be/ | Aug 2025 |
| 32 | BigMotion AI — Best Length for Reels 2025 | https://www.bigmotion.ai/blog/what-is-the-best-length-for-instagram-reels-in-2025 | Jul 2025 |
| 33 | Vizard — A/B Testing Social Media Videos | https://vizard.ai/knowledge-base/social-media-growth/a-b-testing-social-media-videos | May 2025 |
| 34 | SocialInsider — Social Media A/B Testing | https://www.socialinsider.io/blog/ab-testing-social-media/ | Feb 2025 |
| 35 | ReelMind — Social Media Video A/B Tester | https://reelmind.ai/blog/the-social-media-video-a-b-tester-ai-that-helps-you-optimize-content-for-maximum-engagement | 2025 |
| 36 | Claude Plugin Hub — FFmpeg Production | https://www.claudepluginhub.com/skills/galbaz1-gr/ffmpeg-production | May 2026 |
| 37 | ReelMind — FFmpeg AI Enhancement | https://reelmind.ai/blog/ffmpeg-ai-enhancement-next-level-command-line-video-processing-techniques | May 2025 |
| 38 | Flowframes — RIFE Interpolation | https://flowframes.app/ | 2025 |
| 39 | CloudACM — FFmpeg Interpolation | https://www.cloudacm.com/?p=3055 | 2025 |
| 40 | Cliprise — Image Reference for AI Video | https://www.cliprise.app/learn/guides/best-practices/image-reference-upload-ai-video-consistency | 2025 |
| 41 | aividpipeline — Character Consistency in AI Video | https://aividpipeline.com/blog/character-consistency-ai-video | Feb 2026 |
| 42 | Vidau.ai — Seedance 2.0 Breakdown | https://www.vidau.ai/seedance-2-0-the-best-breakdown-of-hype-vs-real-life-for-creators-now/ | 2026 |
| 43 | Framia/Converge AI — Google Omni | https://framia.converge.ai/models/google-omni/ | 2026 |
| 44 | Amplitude Marketing — Facebook Reels 2025 | https://amplitudemktg.com/social-media/how-to-create-facebook-reels-that-attract-an-audience-in-2025/ | Feb 2025 |
| 45 | ArXiv — BrokenVideos (full) | https://arxiv.org/abs/2512.15693 | Dec 2025 |
