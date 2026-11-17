# Gta6TwitchCcuForecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/allianzero/Gta6TwitchCcuForecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/allianzero/Gta6TwitchCcuForecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts how many people watch Grand Theft Auto VI live on Twitch in each hour of its release day (2026-11-19 UTC), from the first hour's print and the launch-day curves of 42 past big game launches. For every hour 2–24 it writes five quantiles (5%, 25%, 50%, 75%, 95%) of concurrent viewers, scored by pinball loss on the log scale.

## How it works

All in log space, where a 20% miss costs the same at any audience size:

1. **Shape library** — every past launch in the case file contributes its release-day curve as log ratios to its own hour-1 print, plus its day peak as `x = log(peak / hour 1)`. Launches whose peak is more than 15× their hour 1 are left out: those unlocked once, globally, late in the day, so their hour 1 was still pre-launch — a different shape from a rolling-midnight launch like GTA VI, whose hour 1 already holds the UK, European and Oceania unlocks.
2. **Peak prediction** — this launch's `x` is predicted from one pre-launch signal: how hour 1 compares with the busiest hour of the day before it, `f = log(hour 1 / pre-24h max)`. When hour 1 already towers over the day before, the peak sits close above it; when hour 1 is small next to the day-before ramp (only New Zealand and Australia live so far), the peak runs far above hour 1. The link is a straight line fitted on the past launches, clamped to the range they actually showed.
3. **Hour-by-hour regression** — for each hour, `log(viewers / hour 1) = a + b·x` fitted on the past launches: early hours barely move with `x` (the night dip), evening hours move almost one-for-one with it (the US prime-time peak). The median is `a + b·x̂`; the spread is the residual spread around that line, widened 1.3× with a 0.25 log floor.
4. **Fallback** — if the history or the library is unusable, it falls back to a flat persistence forecast around hour 1, so the run still writes a valid file.

On the four practice launches (Marvel's Wolverine, Red Dead Redemption 2, God of War Ragnarök, Marvel's Spider-Man 2) this scores a pinball loss of **0.216** with a typical miss of **41%** and 90% coverage of **0.92**, against the house baseline's 0.387 / 83% / 0.78. The program is deterministic (two runs write byte-identical output) and runs in under a second for all four practice cases.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads every `<id>.in` case file in the input directory and writes one `<id>.out` forecast per case to the output directory: `{"hours": [{"hour": 2, "q": [q05, q25, q50, q75, q95]}, …]}` for hours 2–24. Without the environment variables it reads `/input` and writes `/output`, as the grader does. No network, no dependencies, no secrets.

---

<sub>Entered on [make.fun](https://make.fun/?ref=f0netwmk&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
