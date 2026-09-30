# Auto-edit research: platform practice, virality factors, starting rules

Research only. No code was changed. Written 2026-09-29. All sources accessed 2026-09-29.
Everything below is a hypothesis to tune, not a fact about CrapCut's audience, unless a source says otherwise.

Scope: what the edit engine (`viralEdit.ts`, `structurePick.ts`, `moments.ts`, `clips.ts`) should
aim for, given only local signals: chat replay (spikes, distinct chatters, reaction tokens), audio
loudness, whisper transcript with word timings, optional local LLM, video frames via FFmpeg (scene
change, motion inside the facecam rect the user marks once per layout).

## 0. Headline corrections to the proposed rules

| Proposed | Finding | Effect |
|---|---|---|
| Caps: TikTok 60, Shorts 60, Reels 90 | Platform limits moved: Shorts 180 s (since 2024-10-15), Reels 180 s (since 2025-01), TikTok 10 min in-app / 60 min upload. The old caps are no longer platform limits. | Keep 60 s (Reels 90 s) as a PRODUCT cap for completion reasons, not as a platform rule. |
| "Shorts auto-loops so the seam matters most" | Since 2025-03-31 every play or replay counts as a Shorts view, but "engaged views" (the old metric, still used for monetisation and most analytics) exclude loops. Nothing official says loops raise Shorts ranking. | Seam quality matters on all three; it is not a Shorts-specific lever. Downgrade the claim. |
| "Reels 15-30 s best" | Instagram itself advised 30-90 s until Jan 2025 (reported). The 15-30 claim comes from vendor blogs. | Reels target 15-45 s, soft cap 90 s. |
| "Cut pauses over 0.7 s" | Code already cuts at 0.5 s and trims to 0.18 s. Whisper timings here have p90 onset error 135 ms and word ends are pulled 100 ms early, so 0.18 s trimmed gaps leave only about 90 ms per side. | Keep 0.5 s (0.7 s only where game audio is loud), raise the kept gap to about 0.30 s so at least 150 ms remains per side. |
| Hook within 0.5 s | No source measures 0.5 s. Official metrics only say the first ~3 s are scored (Instagram skip rate) or that viewers decide "in the first seconds". | 0.5 s soft, 1.0 s hard. Frame 0 must be real content. |
| "Reels first frame doubles as grid cover" | True by default, but the grid crops 9:16 to 3:4 and the main feed shows 4:5. | Keep hook text and the face inside the centre 1080x1350. |
| Loop only for clips of about 30 s or less | Reasonable; there is no data on the threshold. | Keep as a hypothesis, tie it to the seam score, not to length alone. |

## 1. Evidence grades and sources

Grades: **A** platform documentation or the platform's own statement. **B** peer-reviewed study or
large dataset. **C** vendor data with opaque method, or secondary reporting of an official statement.
**D** creator lore or heuristic. Where I could only read a search excerpt (page not opened or blocked),
the row says so.

| ID | Source (URL) | Published | Grade | Used for |
|---|---|---|---|---|
| S1 | YouTube Help, Shorts creation, https://support.google.com/youtube/answer/15424877 | n/d (eligibility date 2024-10-15) | A | Shorts up to 3 min |
| S2 | YouTube Help, content performance, https://support.google.com/youtube/answer/12220281 (search excerpt only) | n/d | A | Shorts view = start or replay; engaged views exclude loops |
| S3 | YouTube blog, engaged views explained, https://blog.youtube/inside-youtube/engaged-views-youtube-explained/ | 2026-08-19 | A | From 2026-08-24 a view counts from the first frame on all formats; engaged views = watching past the initial seconds; algorithm and monetisation unchanged |
| S4 | PPC Land, https://ppc.land/youtube-changes-how-shorts-views-are-counted-from-march-31/ | 2025-03-26 | C | Shorts view count change of 2025-03-31 |
| S5 | Instagram, Ranking Explained, https://about.instagram.com/blog/announcements/instagram-ranking-explained | 2023-05-31 | A | Reels prediction targets (reshare, watch all the way, like, audio page); demotes low-res, watermarked, muted, bordered, majority-text and already-posted reels |
| S6 | Social Media Today, https://www.socialmediatoday.com/news/instagram-officially-expands-reels-length-3-minutes/737766/ | 2025-01-18 | C | Reels 3 min; earlier guidance under 90 s |
| S7 | Social Media Today, https://www.socialmediatoday.com/news/instagram-adds-retention-insights-reels/758464/ | 2025-08-24 | C (reports A) | Skip rate = viewers who skip in the first 3 s; retention chart |
| S8 | Meta views metric, https://hellopartner.com/2024/11/19/meta-introduces-views-metric-replacing-impressions-across-platforms/ | 2024-11-19 | C | Instagram "Views" counts repeats (effective 2025-04-21) |
| S9 | TikTok Support, how TikTok recommends content (search excerpt only; page redirects) https://support.tiktok.com/en/using-tiktok/exploring-videos/how-tiktok-recommends-content | n/d | A | Signals: likes, shares, comments, watched in full or skipped; no numbers |
| S10 | TikTok Ads Help, https://ads.tiktok.com/help/article/tiktok-reservation-topview (search excerpt) | n/d | A for ads, C for organic | Ad safe zones (in-feed 160 top / 440 bottom / 80 sides) |
| S11 | Zeely, Instagram safe zones, https://zeely.ai/blog/master-instagram-safe-zones/ (reports Meta's unified 9:16 spec, 2026-03) | 2026 | C | Reels safe zone 14% / 35% / 6% |
| S12 | Business Today, https://www.businesstoday.in/technology/news/story/instagram-head-announces-big-changes-3-minute-reels-and-new-look-for-profile-grid-461527-2025-01-21 | 2025-01-21 | C | Grid moved to 3:4 |
| S13 | Musically, trial reels, https://musically.com/2025/06/13/instagram-rolls-out-trial-reels-with-grid-reordering-to-come/ | 2025-06-13 | C | Trial Reels (post to non-followers first) |
| S14 | Social Media Today, hashtag cap, https://www.socialmediatoday.com/news/instagram-implements-new-limits-on-hashtag-use/808309/ (search excerpt only) | about 2025-12 | C | Instagram limits hashtags to 5 |
| S15 | TechCrunch, https://techcrunch.com/2026/04/30/instagram-restricts-reach-of-content-aggregators-in-new-crackdown/ (search excerpt) | 2026-04-30 | C | Originality rules, watermark demotion |
| S16 | Search Engine Journal, https://www.searchenginejournal.com/youtube-targets-mass-produced-content-in-monetization-update/550337/ | 2025-07 | C | YouTube "inauthentic content" (templated, mass-produced) |
| S17 | Fu, Lee, Bansal, Berg, EMNLP 2017, https://aclanthology.org/D17-1102/ | 2017-09 | B | Chat reactions plus visuals predict stream highlights (LoL, Twitch) |
| S18 | Cha, Park et al., EPJ Data Science, https://epjdatascience.springeropen.com/articles/10.1140/epjds/s13688-021-00295-6 (read via BMC summary https://blogs.biomedcentral.com/on-physicalsciences/2021/09/02/epic-moments-live-streaming/) | 2021-09 | B | 2 M Twitch clips: emotes and chat are the key signals; funny 53.9%, surprising 19.3%; clips 5-60 s |
| S19 | Berger and Milkman, J. Marketing Research 2012, https://journals.sagepub.com/doi/abs/10.1509/jmr.10.0353 | 2012 | B (news articles, not video) | High-arousal emotion (awe, anger, anxiety) is shared more than low-arousal |
| S20 | Bakhshi, Shamma, Gilbert, CHI 2014, "Faces engage us", https://dl.acm.org/doi/10.1145/2556288.2557403 | 2014 | B (photos, not video) | Photos with faces: +38% likes, +32% comments (1 M Instagram images) |
| S21 | Fredrickson and Kahneman 1993, JPSP 65, "Duration neglect..." (peak-end rule; search results only, meta-analysis of 174 effect sizes exists) | 1993 | B | People remember the peak and the end |
| S22 | Stivers et al., PNAS 2009, https://www.pnas.org/doi/10.1073/pnas.0903616106 | 2009 | B | Typical conversational gap is about 0-200 ms in 10 languages |
| S23 | Masood et al., CHI 2026, https://arxiv.org/pdf/2503.20030 (abstract only; I did not extract numbers) | 2026-04 | B | TikTok data donation study of how early seconds and content features relate to recommendations |
| S24 | Socialinsider, 6 M TikTok videos Jan-Jun 2026, https://www.socialinsider.io/blog/how-long-are-tiktok-videos/ | 2026 | C (brand accounts, not streamers) | Engagement rate by length: 15-30 s 6.0%, 0-15 s 5.9%, 30-60 s 4.2%; median views highest at 120-180 s |
| S25 | OpusClip, https://www.opus.pro/blog/tiktok-length-format-retention-data | n/d | C- (inconsistent: search summaries cite 2.19 M clips, the page says 500 videos) | 21-34 s completion 62% vs 48% over 60 s; pattern interrupts; captions +12% retention. Treat as lore |
| S26 | Shortimize, https://www.shortimize.com/blog/youtube-shorts-retention-rate ; vidIQ https://vidiq.com/blog/post/youtube-shorts-algorithm/ | 2026 | C- | Benchmarks (80% held at 3 s, average percentage viewed 70%+) with no stated method |
| S27 | Digiday / Facebook, https://digiday.com/media/silent-world-facebook-video/ | 2016 | C (old, Facebook only) | 85% watched muted; captions +12% view time on ads |
| S28 | "Useful but Distracting: Viewer Experience with Keyword Highlights", ACM 2024, https://dl.acm.org/doi/10.1145/3701571.3701574 (search excerpt; page blocked) | 2024 | B- | Highlighted caption words help in learning, felt distracting for everyday viewing |
| S29 | Vimeo, looping, https://vimeo.com/blog/post/does-looping-video-increase-views | 2023-04-13 (updated 2026-08-10) | D | Loop claims with no data; no seam technique |
| S30 | Eklipse, gaming hooks, https://blog.eklipse.gg/beginner-guide-2/stream-hook-strategy-first-two-seconds.html | 2026 | D | Action, reaction, text hooks for gaming clips |
| S31 | Loudness references, https://www.sweetwater.com/insync/what-is-the-youtube-13-lufs-loudness-reference-level/ | n/d | C | YouTube normalises down to about -14 LUFS, does not boost quiet audio |

Not found: any platform statement with a numeric "best length", any platform statement that loops
raise ranking, any controlled study of cold opens, loops, punch-ins, speed ramps or "part 2" series.
Every number in those areas below is a heuristic.

## 2. Layer A: platform practice (as of 2026-09-29)

### 2.1 Length caps and guidance

| | TikTok | YouTube Shorts | Instagram Reels |
|---|---|---|---|
| Platform max | 10 min recorded in app, 60 min uploaded (vendor sources, C; official page not retrievable) | 3 min since 2024-10-15 (S1, A). Reported: Shorts using copyrighted music limited to 60 s | 3 min since 2025-01 (S6, C) |
| Official sweet spot | none found | none found | Instagram advised 30-90 s and "under 90 s" until Jan 2025 (S6, reported) |
| Data on length | 15-30 s best engagement rate on 6 M brand videos, longer videos get more views (S24, C, brand accounts); 21-34 s highest completion (S25, C-) | benchmarks only (S26, C-) | vendor claims only |
| Meaning for CrapCut | 15-45 s target | 15-45 s; game audio may contain licensed music, another reason to stay at or under 60 s | 15-45 s, soft cap 90 s |

Honest read: nothing official says "shorter is better". Completion-based ranking favours clips
where nobody leaves early, so a tight 20-40 s clip beats a padded 60 s one, but a strong long
moment is not penalised by a rule.

### 2.2 How views, loops and replays are counted

| Platform | Rule | Grade |
|---|---|---|
| YouTube Shorts | From 2025-03-31 a Shorts view = the Short starts or replays, no minimum time (S2, S4). From 2026-08-24 the same "first frame" rule applies to all formats (S3). "Engaged views" = watching past the initial seconds and exclude loops; monetisation, Partner Program and the recommendation system are said to be unchanged (S3). Average percentage viewed can exceed 100% when a viewer rewatches (vendor sources, C). | A |
| Instagram | "Views" counts repeated views (effective 2025-04-21, S8). Reels ranking predicts reshare, watch all the way through, like, audio page (S5). Skip rate (first 3 s) and a retention chart exist since 2025-08 (S7). | A / C |
| TikTok | Official page lists likes, shares, comments and "watch in full or skip" as signals (S9, no weights). Vendor sources say loops count as views and rewatch rate is a strong signal; sources conflict on whether same-device loops count. | A for signals, D for loops |

Consequence: a loop is cheap to build and measurable on all three, but no platform documents that
it raises distribution. Treat it as a small, optional polish, never as the main lever.

### 2.3 What each system is known to reward

| Signal | TikTok | Shorts | Reels | Evidence |
|---|---|---|---|---|
| Watch in full / completion | yes (S9) | average percentage viewed (S26, C-) | "watch all the way through" (S5) | A for the existence, no weights |
| Early swipe-away | "skip" (S9) | "viewed vs swiped away" metric shown in Studio (search results, C) | skip rate in first 3 s (S7) | A/C |
| Rewatch | vendor claim | engaged views exclude it (S2) | Views count repeats (S8) | mixed |
| Shares / sends | shares (S9) | not documented | reshare, and sends per reach reported as a top-3 signal in Jan 2025 (C) | A/C |
| Likes, comments | yes | yes | likes (S5) | A |
| Saves | not documented | not documented | not in the official Reels list | none |
| Penalties | n/d | inauthentic (templated, mass-produced) content is demoted for monetisation (S16, C) | low-res, watermarked, muted, bordered, majority-text, already-posted reels (S5, A); aggregators and reposts (S15, C) | A/C |

### 2.4 Hook timing, cold opens, pacing (platform side)

| Topic | What is documented | What is lore |
|---|---|---|
| Hook window | Instagram scores the first 3 s as "skip" (S7). YouTube scores "viewed vs swiped away". TikTok scores skip. None publishes a time constant. | "Decide in 1-2 s", "80% held at 3 s", "50-60% of drop-offs in the first 3 s" (S26, C-) |
| Cold open / payoff first | nothing platform-side | Opus and creator guides (D, C-) recommend a 2 s payoff preview; "pain-point question hooks +23%" comes from 500 videos (S25, C-) |
| Loops | replay counted as a view (Shorts, Instagram) | "seamless loop" advice (S29, D) |
| Pacing | none | "change every 3-5 s" (S25, C-) |
| Captions | Instagram demotes muted reels and majority-text reels (S5) | Facebook 2016: captions +12% view time on ads (S27, C, old) |

### 2.5 Safe zones, 1080x1920

None of these are guaranteed identical to the live apps; UI changes. Values come from vendor
summaries of platform specs (C) except the TikTok ad numbers (A for ads only).

| Platform | Top | Bottom | Left | Right | Grade |
|---|---|---|---|---|---|
| TikTok in-feed ad spec | 160 | 440 | 80 | 80 | A (ads) |
| TikTok organic, third-party | 108 | 320 | 60 | 120 | C |
| Instagram Reels (Meta unified 9:16, reported) | 14% (270) | 35% (670) | 6% (65) | 6% (65) | C |
| Shorts, third-party | 180-225 | 390-575 | 60 | 120 | C/D |
| Instagram grid (3:4) crop | 240 | 240 | 0 | 0 | C |
| Instagram main feed (4:5) crop | 285 | 285 | 0 | 0 | C |

Practical per-platform limit for burned-in text (export is per platform, so use each):

| Platform | Text stays inside (x from-to, y from-to) |
|---|---|
| TikTok | x 80-960, y 160-1480 |
| Shorts | x 60-960, y 225-1350 |
| Reels | x 65-1015, y 285-1250 (285 top keeps hook text inside the 4:5 feed crop; 1250 clears the 35% bottom) |

### 2.6 Covers and first frames

| Platform | Default cover | Note |
|---|---|---|
| Reels | the first frame unless the user picks a frame or uploads a cover (C) | Grid is 3:4 (centre 1080x1440, S12); feed shows 4:5 (centre 1080x1350). A burned-in hook text at frame 0 becomes the grid tile. |
| TikTok | user picks a frame in the app (C) | no data on effect |
| Shorts | chosen frame or upload in the app (C) | Shorts feed shows video, not the cover; the cover matters on the channel page |

### 2.7 Originality and reuse

Instagram (S5, A) demotes watermarked, low-resolution, muted, bordered and majority-text reels and
reels already posted on Instagram. So: export true 1080x1920, no borders (a 16:9 clip letterboxed in
9:16 counts as bordered; only post the 9:16 layout as a Reel), no watermark, always audio. Posting
both variants (straight and cold open) of the same clip to the SAME platform risks the "already
posted" or near-duplicate treatment; post one variant per platform, or use Trial Reels (S13) to
test. YouTube's July 2025 "inauthentic content" wording (S16) targets templated mass production;
a streamer editing his own VOD is low risk but a single identical template on every clip is worth
avoiding (structures already vary per clip).

## 3. Layer B: virality factors for the engine

Priority = evidence strength first, then cost. P1 do or keep, P2 next, P3 later or skip.
"Detect" = measured locally. "Control" = a choice the edit makes.

| # | Factor | Detect locally | Control in the edit | Evidence | Cost | Pri |
|---|---|---|---|---|---|---|
| 1 | Chat spike size, distinct chatters, reaction-token share (LUL, KEKW, OMEGALUL, Pog, WTF, W, F) | chat replay (exists: chatZ). Add distinct-chatter count and emote share to resist spam and one-user floods | choose and centre the moment | B: chat and emotes are the strongest signal for what viewers call epic (S17, S18) | low | P1 |
| 2 | Funny and surprising moments | reaction tokens (LUL/KEKW = funny, Pog/WTF = surprise); LLM classification when present | none | B: funny 53.9% and surprising 19.3% of 2 M Twitch clips (S18) | low | P1 |
| 3 | Emotional arousal (shout, laugh, gasp) | loudness jump over baseline (exists: audioZ), speech rate, chat rate; no classifier needed | punch-in, sparse SFX (exist) | B, but from news sharing not video (S19) | low | P1 |
| 4 | Hook in the first seconds | first-word onset, leading silence, loudness at 0-1 s (from words and loudness) | trim leading silence, start on the peak beat, hook text | A that the window is scored (S7); numbers C- | low | P1 |
| 5 | Payoff clarity and setup length | peak position ratio and setup length (exists in `structureSignals`); LLM can judge "is the setup understandable" | structure choice, cold open only if setup is clear | D plus peak-end (S21, B) | low; LLM part medium | P1 |
| 6 | Ending on the reaction, no dead tail | last word and loud event time | end 1-2 s after the reaction | B (peak-end, S21) | low | P1 |
| 7 | Captions on, word by word, inside the safe zone | transcript (exists) | placement per platform | A that muted and majority-text reels are demoted (S5); C for the +12% (S27) | done | P1 |
| 8 | Originality hygiene (resolution, no border, no watermark, audio) | none | export settings | A (S5) | low | P1 |
| 9 | Loudness | loudnorm measure (exists, -14 LUFS, TP -1.5) | keep | C (S31) | done | P1 |
| 10 | Faces and reactions on screen | motion energy inside the facecam rect (frame difference) at the peak; face presence itself needs a detector, not in the stack | layout shows the cam large near the peak | B for photos (S20: +38% likes, +32% comments), D for video | medium | P2 |
| 11 | Sends and shares (relatability) | funny and surprise tokens as proxy; LLM "does this need stream context" | avoid inside-joke setups needing the stream | A that sends are a top Reels signal (C reports); no way to measure "relatable" | LLM only | P3 |
| 12 | Seam quality for loops | last and first frame similarity, loudness match | loop ending | D (no platform data) | medium | P2 |
| 13 | Scene change and motion | FFmpeg scene score, facecam motion | avoid long static stretches, place zooms | D (S25 "every 3-5 s" is C-) | low | P2 |
| 14 | Text hook | LLM or fallback picks a verbatim span | 2-3 s of the clip's own words | D; Instagram demotes majority-text (S5) | low | P2 |
| 15 | Length near 15-35 s | clip duration | trim, extend | C (S24, S25) | done | P1 |
| 16 | Trending sounds, music, hashtags trends, posting time | needs network trend feeds | none | out of scope (network, accounts, copyright) | n/a | out |

Out of scope under `AGENTS.md`: cloud AI or cloud rankers; any platform account, analytics API or
auto-posting; scheduling; trending or copyrighted music and SFX; generated voice or TTS; invented
on-screen text (labels such as "wait for it", "part 2", fake questions); trend scrapers.
Allowed on screen: the clip's own words and real chat messages only.

## 4. Layer C: correcting the proposed rules

### 4.1 Length

| Proposal | Verdict | Corrected value and reason |
|---|---|---|
| Final floor 10 s | keep | No source for a floor. It only guards against over-trimmed clips. Applies to the FINAL edit; order: skip the edit, extend from download padding, drop (owner decision). Source windows keep `CLIP_MIN_SEC = 12`. |
| Target 15-35 s | keep as a soft score | Vendor data centres on 15-34 s (S24, S25). Twitch clips people choose are 5-60 s (S18). |
| Cap TikTok 60, Shorts 60, Reels 90 | change wording | These are product caps, not platform limits (3 min, 3 min, 10-60 min). `CLIP_MAX_SEC = 60` already caps source windows, so Reels 90 only matters if the cap is raised later. Cold open adds 1.5-4 s: the cap counts it. |
| Content floor: one chat peak inside and speech or a loud event over 40% | keep, measure on the trimmed edit | No source for 40%. It is a sanity check against dead clips; calibrate on real VODs. Counted as words plus frames louder than the clip median minus 15 dB. |

### 4.2 Hook

| Proposal | Verdict | Corrected value and reason |
|---|---|---|
| Speech, reaction or punchline within 0.5 s | soften | No source for 0.5 s. Official scoring windows are "first seconds" (YouTube) and 3 s (Instagram skip rate, S7). Use 0.5 s soft, 1.0 s hard (below that, prefer trimming leading silence or pick a different start). |
| Trim leading silence over 0.3 s | keep, keep 0.15 s | Keep 0.15 s before the first word: whisper onset p90 error is 135 ms in this repo's own measurement (memory: caption-timing-research). |
| Hook or title text 2-3 s | change | Use 2-2.5 s, max 2 lines and about 8 words, verbatim from the clip or real chat, inside the safe zone. Instagram demotes majority-text reels (S5). Skip it when the clip already opens on words that work as a hook (captions are on screen anyway). |
| (new) frame 0 | add | No fade from black, no title card. It is also the Reels grid cover by default. |

### 4.3 Cold open

| Proposal | Verdict | Corrected value and reason |
|---|---|---|
| Payoff plus reaction 1.5-4 s | tighten | 1.5-3 s preferred, 4 s max, and at most 20% of the clip length. No data; supported by peak-end (S21) only for where the payoff sits, not for a preview. |
| Setup at least 8 s | keep | Hypothesis. Mirrors `structurePick` (payoffFirst covers peaks in the first 15% with under 3 s of setup). |
| Skip if the payoff is already in the first 3 s | keep | Align with payoffFirst: skip if payoff is in the first 3 s or the first 15%. |
| Hard cut back, no duplicated captions | keep | Show the caption only once per word within any 2 s window; the preview shows the payoff words, the return starts a fresh caption group. |
| (new) confidence gate | add | Only when peak, word span and setup pass the deterministic checks (no LLM needed). No evidence cold opens beat straight cuts; that is why two variants are allowed and the owner can compare skip rate and retention per variant. |

### 4.4 Loop

| Proposal | Verdict | Corrected value and reason |
|---|---|---|
| Clips of about 30 s or less | keep | No data. Shorter clips replay more naturally. Also require final length 30 s or less AFTER edits. |
| End on a word boundary with 150 ms of quiet | keep, add a max | 150-400 ms of quiet after the last word. Conversational gaps are 0-200 ms (S22), so 150-250 ms reads as a natural breath, and longer than 400 ms is dead air. Word ends here already sit 100 ms early (memory), so measure quiet on audio, not on the word end alone. |
| Similar first and last frames | keep as a score | Seam score = frame similarity of the first and last frame (grayscale downscale, plus the facecam rect) combined with loudness match. Threshold is unproven: start with a similarity of 0.55 or higher and a loudness difference of 3 LU or less over 400 ms, and calibrate on real clips. Below the threshold: no loop, plain end. |
| Crossfade at most 100 ms | keep for audio | Audio crossfade 30-100 ms avoids a click; video stays a hard cut. No end card. |
| Loop is per version | keep | Owner decision. |
| Shorts loops matter most | drop | See section 0. |

### 4.5 Pacing

| Proposal | Verdict | Corrected value and reason |
|---|---|---|
| Cut pauses over 0.7 s | change | Keep the current 0.5 s trigger for speech-only stretches; use 0.7 s when game audio in the gap is above the speech floor (an in-game sound is not dead air). Check that `trimSilences` (word gaps only) does not cut through loud non-speech audio. |
| Kept gap | change | Keep about 0.30 s (at least 150 ms each side). Current target of 0.18 s leaves about 90 ms each side after the 100 ms early word end. |
| Reaction beat 0.5-1 s after the payoff | keep | Peak-end (S21) supports ending on the reaction; never trim this beat. |
| Never cut mid-word, keep 150 ms after words | keep | Cuts inside a VAD speech span are forbidden; prefer VAD span ends over word ends. |
| End 1-2 s after the reaction | keep | Non-loop endings only; loop endings use 150-400 ms. |

### 4.6 Per platform

| Platform | Target | Product cap | Loop | Notes |
|---|---|---|---|---|
| TikTok | 15-45 s | 60 s | allowed | Bottom safe 440. Rewatch is a vendor claim, so the loop is optional. |
| Shorts | 15-45 s | 60 s | allowed | Loops count as Views, not engaged views (S2, S3). Original game audio may carry licensed music, so 60 s also avoids the music cap. Shorts text safe y 225-1350. |
| Reels | 15-45 s | 90 s | allowed | Do not post a letterboxed clip (S5). Keep the first frame and hook inside 1080x1350 centre (grid 3:4, feed 4:5). Skip rate and retention chart exist in Insights (S7): use them to compare variants. |

### 4.7 FINAL RULE TABLE (starting values, all tunable)

| Group | Rule | Value | Evidence |
|---|---|---|---|
| Length | final floor, measured on the edited clip | 10 s | D |
| Length | target (soft score) | 15-35 s | C |
| Length | product cap TikTok / Shorts / Reels | 60 / 60 / 90 s (platform limits are 10-60 min / 3 min / 3 min) | A for limits, D for caps |
| Length | content floor | at least 1 chat peak inside; words plus loud frames cover 40% or more of the edit | D, chat B |
| Length | shortfall order | skip the edit, then extend from download padding, then drop | owner |
| Hook | first speech, reaction or loud event | 0.5 s soft, 1.0 s hard | D (windows A) |
| Hook | leading silence | trim to 0.15 s when over 0.3 s | B (own measurement) |
| Hook | frame 0 | real content, no black or title card | A (grid cover) |
| Hook | hook text | verbatim, 2-2.5 s, 2 lines, about 8 words, in the safe zone, only when the opening is not already a hook | D, A for majority-text penalty |
| Cold open | when | setup 8 s or more; payoff not in the first 3 s or 15%; deterministic confidence gate | D |
| Cold open | preview | payoff plus reaction 1.5-3 s (4 s max), at most 20% of clip | D |
| Cold open | join | hard cut back; no word shown twice within 2 s | D |
| Loop | eligible | final length 30 s or less; seam score passes | D |
| Loop | ending | last word plus 150-400 ms of quiet, cut on a word boundary | B/D |
| Loop | seam | frame similarity 0.55 or more (calibrate) and loudness within 3 LU; audio crossfade 30-100 ms; no end card | D |
| Pacing | pause trigger | over 0.5 s (0.7 s when game audio is loud) | D |
| Pacing | kept gap | about 0.30 s, at least 150 ms per side | B (own measurement) |
| Pacing | reaction beat | keep 0.5-1.0 s after the payoff | B (peak-end) |
| Pacing | never | cut inside a word or a VAD span | own |
| Pacing | ending | 1-2 s after the reaction (loops: 150-400 ms) | B (peak-end) |
| Variants | at most two per clip | straight, plus cold open when it qualifies | owner |
| Export | per platform | text inside the platform safe rect (section 2.5); no borders, no watermark, 1080x1920, audio always, -14 LUFS | A/C |

## 5. Extra ideas

| # | Idea | Recommendation | Evidence | Rough cost |
|---|---|---|---|---|
| 1 | Per-clip "virality score" to rank and pre-select | **Yes**, framed as "best moments first", not a view prediction | B for detecting what viewers call epic (S17, S18); nothing predicts platform performance. `moments.ts` already has chatZ and audioZ; add distinct chatters, emote share, payoff clarity, facecam motion | low to medium |
| 2 | LLM hook text styles (question, stakes, "wait for it") with a no-LLM fallback | **No** for styles (invented text breaks the owner rule). **Yes** to picking a verbatim span: the LLM chooses among spans, the fallback picks the best 3-8 word span near the peak (this is what `quoteCard` already does) | D; Instagram demotes majority-text (S5) | low |
| 3 | Smart cover and first-frame choice per platform | **Yes, later**: export a cover PNG per platform (Reels 3:4 crop from the reaction frame, face and hook inside the centre), and make frame 0 itself strong. Auto-scoring the frame later | B for photos with faces (S20); grid and feed crops (S11, S12, C) | low for the PNG, medium for scoring |
| 4 | Facecam punch-in on the reaction beat | **Later**. A single snap zoom on the peak already exists; a facecam-specific zoom needs the cam rect and motion timing and has no evidence beyond lore. Reuse the existing cap of 1-2 zooms per 15-20 s | D | medium |
| 5 | Emphasis styling of key words in captions | **Yes, but keep it subtle** (`isKeywordWord` exists): colour only, at most 1 word per caption group, no bounce | B- says highlights help but distract in casual viewing (S28); vendor +12% is C- | low, mostly done |
| 6a | Speed ramps, freeze-frames at the payoff | **No** for ramps (audio sync and pitch, no evidence). Freezes already exist in `freezeLoop`; leave as is | D | high for ramps |
| 6b | Locally generated sound design (no copyrighted SFX) | **Keep as is** (boom, whoosh, pop are synthesised and sparse). No new work | D; also risk of masking game audio | done |
| 7 | Platform-ready post text (title, description, few hashtags), copied with one click, never posted | **Yes, later**: title from the clip title, description from the clip's own words, 3-5 hashtags from the VOD's game/category metadata only (Instagram caps at 5, S14; YouTube shows the first 3). LLM optional, fallback is templates from real data. It is not on-screen text, but confirm with the owner because the rule says no invented text | C | low to medium |
| 8 | "Part 1 / part 2" series from one long moment | **Later, low priority**. No data found. Only for moments over the product cap; each part must stand alone; no invented "part 2" label on screen | D | medium |
| 9a | Originality hygiene checks at export | **Yes**: assert 1080x1920, audio present, no letterbox for the Reels export, no watermark | A (S5) | low |
| 9b | Guidance to post one variant per platform, or test with Trial Reels | **Yes** (a hint in the export or review UI, not a feature) | C (S13, S5) | low |
| 9c | Silence trimming that is loudness-aware | **Yes**: word gaps alone can cut through loud game sound | own reasoning | low |
| 9d | Analytics loop without telemetry | **Yes as advice only**: the owner compares Reels skip rate (S7), Shorts viewed-vs-swiped-away, TikTok retention per variant by hand; nothing is sent from the app | C | none |

## 6. Weak spots and how to check them

- No dataset is about stream clips on these three platforms. Grades B/C are from adjacent contexts (news sharing, photos, brand TikTok videos, LoL streams).
- Vendor retention numbers (80% at 3 s, 62% completion at 21-34 s, +23% question hooks, +12% captions) have no stated methods; do not tune to them.
- The safe-zone numbers change with app UI updates; re-check each release with a test export.
- Loops: whether they raise ranking is unknown; YouTube's own definition excludes them from engaged views.
- Cold open: no evidence it beats a straight cut; the two-variant design plus manual comparison is the test. With a few dozen clips per platform there is little statistical power, so treat differences as hints.
- Thresholds to calibrate on real VOD clips before shipping: content floor 40%, seam score, loud-gap trigger, 0.30 s kept gap.
