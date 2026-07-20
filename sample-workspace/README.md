# Welcome to the Geocluster Research Harness

This workspace comes pre-loaded with a small **synthetic** geology project so
you can try the agent right away.

## First step: connect a model

Open the **Geology Agent** panel (right sidebar). If you haven't provided an
API key yet, the setup screen lets you pick any supported provider — OpenRouter,
Anthropic, OpenAI, a local Ollama model, and more — and paste your key.

## What's in this workspace

| Path | What it is |
|---|---|
| `data/meridian_ridge_geochem.csv` | Synthetic multi-element geochemistry (240 samples) |
| `data/sample_well.las` | Tiny example well log (LAS format) |
| `reports/meridian_ridge_technical_report.md` | Synthetic exploration report |
| `geology_analysis.py` | Example Python analysis script |

## Things to try

Ask the agent (in its chat panel):

- *"Inspect data/meridian_ridge_geochem.csv and summarize the dataset."*
- *"Cluster the geochemistry and map the clusters against lithology."*
- *"Which elements are the best pathfinders for gold here?"*
- Switch to **Report Analysis** mode (chip above the chat box) and ask
  questions about `reports/meridian_ridge_technical_report.md` — answers are
  grounded in the report with citations.

The heavy lifting (clustering, rasters, plots, anomaly ranking) runs through
the bundled geological MCP server — the agent will call those tools as needed
and drop generated figures back into this workspace.

> All data in this workspace is computer-generated. The Meridian Ridge
> Prospect does not exist.
