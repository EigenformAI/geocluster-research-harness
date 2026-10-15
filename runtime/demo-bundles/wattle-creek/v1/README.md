# Wattle Creek

Explore sample data, maps, and reports in your own project. All measurements and the training outline are synthetic. You can edit these files, add your data, and save new outputs.

## 1. Inspect the data

Open `assays/surface_samples.csv`, `drilling/collars.csv`, and `drilling/assays.csv`. Coordinates are GDA2020 / MGA zone 51 (EPSG:7851), in metres. Au, Cu, and As are parts per million (ppm). Blank Au values are missing; `<0.005` and `<0.01` are reported below detection, not zero.

The collar elevation `rl` is an invented height in metres with no surveyed vertical datum. Hole depths are measured downhole in metres; holes are vertical (dip -90 degrees). WC141 has assay intervals but no recorded collar; preserve these intervals when checking the files.

Open `maps/overview.map.json` when sample map preparation finishes. A collar symbol shows the highest detected Au value in that hole at its collar, not the interval position or an interpolated orebody. The `gis/training_area.geojson` outline is invented; it is not a legal tenement. Its longitude/latitude uses the recorded GDA2020/WGS84 map-context approximation.

## 2. Ask a question

Open Agent, copy a question into the composer, edit it, and choose Send. Sending uses your ordinary account and model access.

### Find samples above a threshold

Read `assays/surface_samples.csv`. Select reported numeric Au values at least 0.1 ppm and sort highest first. Keep blank and below-detection values separate. Save a CSV and a Markdown summary in this conversation's output folder. Include source hashes, counts, and the threshold. Leave the input unchanged.

The 0.1 ppm threshold is a filter for this exercise, not an economic cutoff.

### Check the drilling inputs

Compare `drilling/assays.csv` with `drilling/collars.csv` by `hole_id`. Check collar uniqueness and interval depths. Save unmatched intervals and a Markdown QA report in this conversation's output folder. Preserve reported assay values and do not invent missing collars.

## 3. Save or export an output

Inspect the output table. In the map, choose Add layers, then Locate on that CSV. Select its ID, easting, northing, Au field, ppm unit, and EPSG:7851 reference. Compare it with the original samples layer. Save a new view or explicitly replace a view you choose.

Use Create visual to download a PNG. The export excludes public context and background layers. Upload the downloaded image through the normal project upload action if you want it saved in your project. Open a Markdown report and use Print to print or save a PDF.

For an example you can inspect immediately, open `examples/copper_by_sample_type.csv` and `examples/copper_summary.md`. These are precomputed Cu summaries, not an agent conversation.

## Sources and reuse

`provenance/manifest.json` records this seed's identity, hashes, schemas, coordinate assumptions, and calculations. The generated sample assets are dedicated under CC0-1.0; see `LICENSE.txt`. Your edits are ordinary project work. Updates to the sample template do not update these files.
