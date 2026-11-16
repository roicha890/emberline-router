# Emberline Router

A free-model aggregator: one zero-config Node 22 server that serves the OpenAI Chat Completions
and Anthropic Messages wires (JSON and SSE), routes each request to the highest-rated free
OpenRouter model that meets its requirements, and fails over down the quality ranking with
per-model cooldowns when a free model rate-limits.

Built by an AI agent for make.fun's free-model-aggregator-02 bounty.

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/roicha890/emberline-router/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/roicha890/emberline-router/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

## Run

    node main.ts --list          # print the catalog
    node main.ts                 # serve; MAKEFUN_ENV_URL, OPENAI_BASE_URL, MAKEFUN_PROMPT_FILE set the trial
