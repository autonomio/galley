# Charts through Astetik: the interface galley needs (draft, to confirm)

Galley draws its data charts with [Astetik](https://github.com/autonomio/astetik) 2.x, through its existing
contract: a declared JSON specification, one design manifest, supplied data, and the `astetik render` command that
writes a verified evidence bundle. This page is what galley sends, what it reads back, and what Astetik needs to add
for the three chart kinds galley uses.

## The rule behind it

No model types a number into a chart. Galley's storyteller chooses the chart, the kind and the data by reference
(a simulation output, a measurement of the authors' data); galley writes the data file from its own records; Astetik
draws exactly those values. The chart and the text then come from one source and cannot disagree.

## The three kinds, pinned

| Kind | Shows | Data galley supplies | Astetik today | Needed |
| --- | --- | --- | --- | --- |
| `hist` | The distribution of one quantity | Raw values, one row each: a simulation's draws (regenerated exactly from its spec and seed) or a dataset column | Exists | Reference lines (below); overlaid groups (`hue`, at most 3) on shared bin edges |
| `line` | A quantity over time or against a setting, with its band | One row per point: `x`, `y`, `lower`, `upper`; `series` when there are several | Exists, no band | `options.band = {"lower": col, "upper": col}`: a shaded band of supplied bounds, never estimated by Astetik |
| `interval` | Estimates with their intervals, side by side | One row per estimate: `label`, `estimate`, `lower`, `upper`; optional `group` | Missing | A new kind: dot for the estimate, bar from lower to upper, one row per label, horizontal by default; supplied values drawn as given |

For every kind:

- `options.marks = [{"axis": "x" | "y", "value": number, "label": text}]`: thin reference lines (a threshold, a floor),
  labelled at the line. Galley passes only values the paper's text states.
- `descriptions` carries what a column holds and how it was computed, for example
  `"lower": "5th percentile of 20,000 Monte Carlo draws"`. Astetik records it in the evidence and does not recompute.
- `units` is given for every numeric column (Astetik already requires it on paper).
- No title inside the figure: the paper's caption carries it.

## Grids of panels

One figure may hold 2 to 4 panels, each any of the three kinds, mixed:

```json
{
  "schema_version": "1.0",
  "paper": true,
  "layout": {"rows": 1, "cols": 2},
  "panel_labels": true,
  "panels": [
    {"kind": "hist", "data": "panel-1.csv", "x": "value", "hue": "series", "key": ["row"],
     "labels": {"x": "Execution bloat", "y": "Draws"}, "units": {"value": "orders of magnitude"},
     "options": {"marks": [{"axis": "x", "value": 3, "label": "3 orders"}]}},
    {"kind": "interval", "data": "panel-2.csv", "y": "label", "x": "estimate", "key": ["label"],
     "options": {"lower": "lower", "upper": "upper"},
     "labels": {"x": "Search bloat minus execution bloat"}, "units": {"estimate": "orders of magnitude"}}
  ]
}
```

Panels are lettered (a), (b), … in reading order, share the manifest, and fit the paper width together. A single
chart is sent as a plain specification (no `panels`), as Astetik takes today.

Command: `astetik render --spec figure.json --manifest manifest.json --output <new dir>`, with each panel's `data`
path resolved beside the specification (a single chart keeps `--data`).

## Design galley supplies

```json
{
  "schema_version": "1.0",
  "typography": {"font": "New Computer Modern", "font_path": "<galley's copy of the font>", "fontsize": 8,
                 "labelsize": 8, "ticksize": 7, "legendsize": 7},
  "paper": {"preset": "single", "width_mm": 140, "aspect": 1.6, "dpi": 600, "min_fontsize": 7}
}
```

The paper's own typeface and its text width, so a chart reads as part of the page. Galley needs the font file to
give Astetik (New Computer Modern is OFL-licensed; galley would carry a copy).

## What galley reads back

From the JSON Astetik prints on success: `result_id`, `output` and `verification`. From the bundle:

- the figure as PNG (600 dpi) and as PDF or SVG, at fixed file names (`figure.png`, `figure.pdf`, `figure.svg`);
- the numerical table of every mark (`table.csv`), which galley checks against its records;
- `verification.passed`; galley places a chart only when it is true.

The bundle goes into the paper's evidence package beside the simulation and analysis packages.

## Failure

A declared failure (`code`, `message`, `details` on stderr, exit status 2) goes back to galley's author once, to
revise the chart; if it fails again the chart is left out and the paper keeps the figure it had. Galley never draws a
chart by other means.

## Open for you to decide

1. The three kinds above, and their names (`interval` for dot-and-interval).
2. The panel grid as specified, with its command form.
3. The fixed file names in the bundle.
4. Where galley's copy of New Computer Modern comes from.
