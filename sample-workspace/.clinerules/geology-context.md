# Geological Analysis Context

## Data Conventions
- Geochemical data is in long format: sample_id/filename, chem_code, value, unit, major_lithology
- Detection limits: `<value` (halved for analysis), `>value` (used as-is)
- Core tray images: JPEG/PNG, named by tray number
- Coordinate system: GDA2020 / MGA Zone 55 (EPSG:28355) unless stated otherwise

## Analysis Preferences
- Start with major oxides (SiO2, Al2O3, Fe2O3, MgO, CaO, Na2O, K2O, TiO2, MnO, P2O5) unless user specifies different elements
- For gold exploration contexts, check Au, As, Cu, Bi, Te correlations
- Log-transform highly skewed elements (Au, Ag, As) before clustering
- Available clustering algorithms: K-Means, GMM, DBSCAN, Hierarchical, OPTICS, Fuzzy C-Means

## MCP Tool Naming Conventions
- `inspect_*` / `get_*` → read-only operations (no side effects)
- `compute_*` / `cluster_*` → pure functions (deterministic transformations)
- `plot_*` → visualization generation (creates image artifacts)
- `export_*` → side effects (file creation, data persistence)

## Element Groups Reference
- **Major oxides**: SiO2, Al2O3, Fe2O3, MgO, CaO, Na2O, K2O, TiO2, MnO, P2O5
- **Base metals**: Cu, Pb, Zn, Ni, Co
- **Precious metals**: Au, Ag, Pt, Pd
- **Pathfinder elements**: As, Sb, Bi, Te, Se, Mo, W
- **Rare earth elements (REE)**: La, Ce, Pr, Nd, Sm, Eu, Gd, Tb, Dy, Ho, Er, Tm, Yb, Lu
