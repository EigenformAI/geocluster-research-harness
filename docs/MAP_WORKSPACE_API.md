# Prepare and reopen maps

Use the workspace file API to prepare layers from captured sources and save
`.map.json` view recipes. Your browser client composes and renders the map.
Read request schemas from `/files/openapi.json` and provider availability from
`/files/info`.

## Capture and prepare selected sources

1. Capture each selected file through `/files/captures`.
2. Supply the complete captured source to `/files/preparations` with a new
   `requestId` and the appropriate preparation type.
3. Select shapefile companions and assay collar tables explicitly. A multi-file
   capture set is not an atomic snapshot of all input files.
4. Follow asynchronous preparation jobs to their retained representation.
5. Query the representation for its display or recorded assay product.
6. Renew input leases while using the layer.

Use the retained request receipt after a lost response. A new column selection,
coordinate assumption, or location recipe is a new intent with a new ID.
Honor capacity responses and `Retry-After` instead of repeatedly redispatching
native work. A disconnected browser does not establish job cancellation.

## Review assay meaning before display

Choose columns by exact name. Declare source CRS, axis order, units, missing-value
tokens, and numeric sentinels. The runtime records your units; it does not verify
or convert them.

Keep detected, censored, missing, and invalid values distinct. A value reported
below detection is a threshold, not a detected measurement. Locale decimal commas
and thousands separators are not accepted numerical spelling. Review diagnostics
before interpreting excluded rows.

For collar summaries, supply assay intervals and one captured collar table.
Depths must already be in metres. The product places the maximum detected value
among selected valid intervals at the collar. It is not a downhole measurement,
an interval-weighted grade, or an interpolated orebody. Duplicate collar IDs make
the hole ambiguous; unmatched intervals remain diagnostic evidence.

Preserve row locators and source identities in selections. Under log styling,
show detected zero and negative values separately rather than silently dropping
them.

## Review coordinate and raster assumptions

If a raster has no usable declared CRS, provide an explicit assumption. Do not
position an unreferenced thumbnail by guessing. Approximate coordinate operations
require explicit opt-in.

Retain the returned projection-environment fingerprint in later queries and saved
recipes when available. Installed grids and operation metadata do not establish
survey accuracy or the coordinate epoch of WGS84 observations.

Raster `map-display` is a positioned grayscale display with nearest-cell sampling.
Its stretch is display evidence, not numerical sampling. Reported scale, offset,
and colour-table metadata are not applied by that display. Use a suitable
numerical workflow before making claims about raster values.

## Save and reopen a view

Save through `/files/map-views` with a stable `operationId`, an ordinary `.map.json`
path, and your view document. Use create intent for a new file. For replacement,
supply its current observation. Inspect the operation receipt after an uncertain
save.

Preserve complete ordered source identities, layer recipes, display fingerprints,
credits, and ownership declarations. Select only client-owned layers for output;
hosted map context is not an owned output layer. The runtime saves recipes, not
rendered report images.

When reopening, inspect each source's current relation and capture availability
separately from prepared-product availability. A current file can change while
its recorded product remains available. A saved recipe does not retain captured
products forever or guarantee reproduction after a projection-environment change.

If a recorded product is unavailable:

1. Locate or replace the missing sources.
2. Capture the selected current files.
3. Prepare them with new request IDs.
4. Review changed source identities and display assumptions.
5. Save a successor view explicitly.

Do not silently rebind a saved view to current files. Check the ordinary file's
persistence outcome separately from local save success.
