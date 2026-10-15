#pragma once
#include <chrono>
#include <cerrno>
#include <cstdlib>

// Complete captured tables, not a sample. Source coordinates and display placement
// remain separate, and Placement is the sole coordinate-operation authority.
static constexpr const char *ASSAY_PARSER = "bounded-gdal-assay-v1";
struct AssayClock {
	std::chrono::steady_clock::time_point start = std::chrono::steady_clock::now();
	void check() const { if (std::chrono::steady_clock::now() - start > std::chrono::seconds(30)) reject("gis_time_limit", "Assay work exceeded the 30-second native clock."); }
};
static void assay_utf8(const Bytes &bytes) {
	for (size_t i = 0; i < bytes.size();) {
		unsigned char c = bytes[i++]; if (!c) reject("assay_table_invalid", "Assay text contains NUL."); if (c < 128) continue;
		uint32_t code; int continuation;
		if (c >= 0xc2 && c <= 0xdf) { code = c & 31; continuation = 1; }
		else if (c >= 0xe0 && c <= 0xef) { code = c & 15; continuation = 2; }
		else if (c >= 0xf0 && c <= 0xf4) { code = c & 7; continuation = 3; }
		else reject("assay_table_invalid", "Assay text is not valid UTF-8.");
		if (i + continuation > bytes.size()) reject("assay_table_invalid", "Assay UTF-8 ends inside a character.");
		for (int n = 0; n < continuation; n++) { unsigned char next = bytes[i++]; if ((next & 0xc0) != 0x80) reject("assay_table_invalid", "Assay UTF-8 continuation is invalid."); code = (code << 6) | (next & 63); }
		if ((continuation == 2 && code < 0x800) || (continuation == 3 && code < 0x10000) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) reject("assay_table_invalid", "Assay UTF-8 is overlong or outside the Unicode scalar domain.");
	}
}
static std::string assay_trim(const std::string &s) {
	size_t a = 0, b = s.size(); auto space = [](char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
	while (a < b && space(s[a])) a++; while (b > a && space(s[b-1])) b--; return s.substr(a, b-a);
}
static void assay_closed(const J &j, std::initializer_list<const char *> keys) {
	if (!j.is(json_type_object)) reject("gis_invalid_options", "Assay recipe fields must be objects.");
	int recognized = 0; for (auto key : keys) if (j.has(key)) recognized++;
	if (recognized != j.size()) reject("gis_invalid_options", "Assay recipe contains unsupported fields.");
}
static std::string assay_string(const J &j, size_t max, bool empty = false) {
	if (!j.is(json_type_string) || (!empty && j.str().empty()) || j.str().size() > max || j.str().find('\0') != std::string::npos) reject("gis_invalid_options", "Assay recipe string is missing or exceeds its ceiling.");
	std::string text = j.str(); Bytes bytes(text.begin(), text.end()); assay_utf8(bytes);
	return j.str();
}
static J assay_columns(const J &j, bool surface, bool collars = false) {
	if (collars) assay_closed(j, {"hole", "x", "y"});
	else if (surface) assay_closed(j, {"id", "x", "y", "analyte", "qualifier"});
	else assay_closed(j, {"hole", "from", "to", "analyte", "qualifier"});
	J result = J::object(); std::set<std::string> selected;
	std::vector<const char *> required = collars ? std::vector<const char *>{"hole", "x", "y"} : surface ? std::vector<const char *>{"id", "x", "y", "analyte"} : std::vector<const char *>{"hole", "from", "to", "analyte"};
	if (!collars && j.has("qualifier")) required.push_back("qualifier");
	for (auto key : required) { auto name = assay_string(j.get(key), 256); if (!selected.insert(name).second) reject("gis_invalid_options", "Assay column roles must select distinct headers."); result.set(key, name); }
	return result;
}
static bool assay_finite_json(const J &j) { return (j.is(json_type_double) || j.is(json_type_int)) && std::isfinite(j.number()); }
static J assay_recipe(const J &options) {
	assay_closed(options, {"mode", "columns", "collars", "sourceCrs", "allowApproximate", "unit", "depthUnit", "depthWindow", "numbers", "environmentFingerprint"});
	std::string mode = options.get("mode").str(); bool surface = mode == "surface";
	if (!surface && mode != "collar-summary") reject("gis_invalid_options", "Choose surface or collar-summary assay preparation.");
	J recipe = J::object(); recipe.set("mode", mode); recipe.set("columns", assay_columns(options.get("columns"), surface));
	J crs = options.get("sourceCrs"); assay_closed(crs, {"code", "axisOrder"});
	if (!std::regex_match(crs.get("code").str(), std::regex("EPSG:[1-9][0-9]{0,6}|OGC:CRS84")) || (crs.get("axisOrder").str() != "xy" && crs.get("axisOrder").str() != "yx")) reject("gis_invalid_options", "Assay source CRS and XY or YX order must be explicit.");
	recipe.set("sourceCrs", crs); J unit = options.get("unit"); assay_closed(unit, {"name", "basis"}); assay_string(unit.get("name"), 128);
	if (unit.get("basis").str() != "user-assigned" && unit.get("basis").str() != "source-declared") reject("gis_invalid_options", "Record the assay unit assignment basis."); recipe.set("unit", unit);
	if (options.has("allowApproximate") && !options.get("allowApproximate").is(json_type_boolean)) reject("gis_invalid_options", "allowApproximate must be boolean."); recipe.set("allowApproximate", options.get("allowApproximate").boolean());
	if (options.has("environmentFingerprint")) { assay_string(options.get("environmentFingerprint"), 256); if (options.get("environmentFingerprint").str() != fingerprint) reject("gis_environment_changed", "Assay recipe refers to a different projection environment."); recipe.set("environmentFingerprint", options.get("environmentFingerprint")); }
	if (surface) { if (options.has("collars") || options.has("depthUnit") || options.has("depthWindow")) reject("gis_invalid_options", "Surface assays cannot contain collar or depth recipes."); }
	else {
		if (!options.has("collars")) reject("gis_invalid_options", "Collar summaries require an explicit captured collar table.");
		J collars = options.get("collars"); assay_closed(collars, {"member", "columns"}); std::string member = assay_string(collars.get("member"), 128);
		if (!basename(member)) reject("gis_invalid_options", "Collars must identify a captured basename.");
		J normalized = J::object(); normalized.set("member", member); normalized.set("columns", assay_columns(collars.get("columns"), false, true)); recipe.set("collars", normalized);
		if (options.get("depthUnit").str() != "m") reject("gis_invalid_options", "Collar depths and windows must already be in metres."); recipe.set("depthUnit", "m");
		J window = options.has("depthWindow") ? options.get("depthWindow") : J::parse("{\"kind\":\"whole-hole\"}");
		if (window.get("kind").str() == "whole-hole") assay_closed(window, {"kind"});
		else if (window.get("kind").str() == "range") { assay_closed(window, {"kind", "from", "to"}); if (!assay_finite_json(window.get("from")) || !assay_finite_json(window.get("to")) || window.get("from").number() < 0 || window.get("to").number() <= window.get("from").number()) reject("gis_invalid_options", "Depth windows require finite 0 <= from < to."); }
		else reject("gis_invalid_options", "Choose whole-hole or a half-open depth range."); recipe.set("depthWindow", window);
	}
	J numbers = options.has("numbers") ? options.get("numbers") : J::object(); assay_closed(numbers, {"missingTokens", "sentinels"});
	J missing = numbers.has("missingTokens") ? numbers.get("missingTokens") : strings({"", "NA", "N/A", "NULL"}), sentinels = numbers.has("sentinels") ? numbers.get("sentinels") : J::array();
	if (!missing.is(json_type_array) || missing.size() > 32 || !sentinels.is(json_type_array) || sentinels.size() > 32) reject("gis_invalid_options", "Assay missing tokens and sentinels must be bounded arrays.");
	for (int i = 0; i < missing.size(); i++) assay_string(missing.at(i), 128, true);
	for (int i = 0; i < sentinels.size(); i++) if (!assay_finite_json(sentinels.at(i))) reject("gis_invalid_options", "Assay sentinels must be finite numbers.");
	J normalized = J::object(); normalized.set("missingTokens", missing); normalized.set("sentinels", sentinels); recipe.set("numbers", normalized); return recipe;
}
struct AssayTable {
	std::string name; std::vector<std::string> headers; std::vector<std::vector<std::string>> records;
	std::map<std::string, size_t> indices;
	AssayTable(const std::string &memberName, const Bytes &bytes, const Limits &limits, const AssayClock &clock) : name(memberName) {
		assay_utf8(bytes); std::vector<std::string> row; std::string cell; bool quoted = false, closed = false, started = false;
		auto append = [&](char c) { cell.push_back(c); if (static_cast<int64_t>(cell.size()) > limits.assayCellBytes) reject("assay_cell_limit", "Assay cell bytes exceed their ceiling."); };
		auto field = [&] { row.push_back(std::move(cell)); cell.clear(); closed = false; if (static_cast<int64_t>(row.size()) > limits.assayColumns) reject("assay_column_limit", "Assay columns exceed their ceiling."); };
		auto record = [&] {
			field(); if (headers.empty()) { headers = std::move(row); for (size_t n = 0; n < headers.size(); n++) if (headers[n].empty() || !indices.emplace(headers[n], n).second) reject("assay_table_invalid", "Assay headers must be nonempty and unique."); }
			else { if (row.size() != headers.size()) reject("assay_table_invalid", "Assay data records must match the complete header width."); records.push_back(std::move(row)); if (static_cast<int64_t>(records.size()) > limits.assayRows) reject("assay_row_limit", "Assay data rows exceed the per-table ceiling."); }
			row.clear(); started = false;
		};
		char delimiter = lower(name).substr(name.find_last_of('.') + 1) == "tsv" ? '\t' : ',';
		size_t start = bytes.size() >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf ? 3 : 0;
		for (size_t i = start; i < bytes.size(); i++) {
			if ((i & 65535) == 0) clock.check(); char c = static_cast<char>(bytes[i]);
			if (quoted) { if (c == '"') { if (i + 1 < bytes.size() && bytes[i+1] == '"') { append('"'); i++; } else { quoted = false; closed = true; } } else append(c); continue; }
			if (c == delimiter) { field(); started = true; }
			else if (c == '\r' || c == '\n') { if (c == '\r' && i + 1 < bytes.size() && bytes[i+1] == '\n') i++; record(); }
			else if (closed) reject("assay_table_invalid", "Unexpected bytes after a quoted assay cell.");
			else if (c == '"') { if (!cell.empty()) reject("assay_table_invalid", "Quotes must enclose the entire assay cell."); quoted = true; started = true; }
			else { append(c); started = true; }
		}
		if (quoted) reject("assay_table_invalid", "Assay table ends inside a quoted cell."); if (started || !row.empty() || !cell.empty() || closed) record();
		if (headers.empty()) reject("assay_table_invalid", "Assay table requires a header record."); clock.check();
	}
	void columns(const J &columns, std::initializer_list<const char *> keys) const { for (auto key : keys) if (columns.has(key) && !indices.count(columns.get(key).str())) reject("assay_column_missing", "A selected assay header is absent from the captured table."); }
	std::string cell(size_t row, const J &columns, const char *key) const { return columns.has(key) ? records.at(row).at(indices.at(columns.get(key).str())) : ""; }
	J lineage(size_t row) const { J j = J::object(); j.set("memberName", name); j.set("recordOrdinal", static_cast<int64_t>(row + 2)); j.set("locator", name + ":" + std::to_string(row + 2)); return j; }
	J metadata() const { J j = J::object(), names = J::array(); for (const auto &h : headers) names.add(h); j.set("memberName", name); j.set("format", lower(name).substr(name.find_last_of('.') + 1)); j.set("columns", names); j.set("dataRows", static_cast<int64_t>(records.size())); return j; }
};
static bool assay_number(const std::string &text, double &number) {
	// Dot decimal only: no locale, thousands, hex, NaN, infinity, or trailing junk.
	if (text.empty()) return false; size_t i = 0; if (text[i] == '+' || text[i] == '-') i++;
	size_t digits = 0; while (i < text.size() && text[i] >= '0' && text[i] <= '9') { i++; digits++; }
	if (i < text.size() && text[i] == '.') { i++; while (i < text.size() && text[i] >= '0' && text[i] <= '9') { i++; digits++; } }
	if (!digits) return false;
	if (i < text.size() && (text[i] == 'e' || text[i] == 'E')) { i++; if (i < text.size() && (text[i] == '+' || text[i] == '-')) i++; size_t start = i; while (i < text.size() && text[i] >= '0' && text[i] <= '9') i++; if (i == start) return false; }
	if (i != text.size()) return false; char *end = nullptr; number = std::strtod(text.c_str(), &end); return end == text.c_str() + text.size() && std::isfinite(number);
}
static J assay_value(const std::string &raw, const std::string &rawQualifier, const J &numbers) {
	std::string text = assay_trim(raw), qualifier = assay_trim(rawQualifier), inlineQualifier;
	if (text.rfind("<=", 0) == 0) { inlineQualifier = "<="; text = assay_trim(text.substr(2)); }
	else if (text.rfind("<", 0) == 0) { inlineQualifier = "<"; text = assay_trim(text.substr(1)); }
	J value = J::object(); value.set("state", "invalid"); value.set("value", J()); value.set("qualifier", J());
	if (qualifier != "" && qualifier != "=" && qualifier != "<" && qualifier != "<=" && qualifier != "ND") return value;
	if (!inlineQualifier.empty() && !qualifier.empty() && qualifier != inlineQualifier && qualifier != "ND") return value;
	std::string effective = inlineQualifier.empty() ? qualifier : inlineQualifier; bool censored = effective == "<" || effective == "<=" || effective == "ND";
	value.set("qualifier", censored ? J(effective) : J()); double numeric;
	if (!assay_number(text, numeric)) {
		J tokens = numbers.get("missingTokens"); for (int i = 0; i < tokens.size(); i++) if (text == tokens.at(i).str() && inlineQualifier.empty()) { value.set("state", censored && effective == "ND" ? "censored" : "missing"); return value; }
		return value;
	}
	J sentinels = numbers.get("sentinels"); for (int i = 0; i < sentinels.size(); i++) if (numeric == sentinels.at(i).number()) { if (!censored) value.set("state", "missing"); return value; }
	value.set("state", censored ? "censored" : "detected"); value.set("value", numeric); return value;
}
static std::string assay_hash(const std::string &text) {
	unsigned char bytes[32]; unsigned int length; auto *ctx = EVP_MD_CTX_new(); if (!ctx) reject("gis_resource_limit", "Assay fingerprint allocation failed."); EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr); EVP_DigestUpdate(ctx, text.data(), text.size()); EVP_DigestFinal_ex(ctx, bytes, &length); EVP_MD_CTX_free(ctx);
	std::ostringstream out; for (auto byte : bytes) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte); return out.str();
}
static J assay_process(const Members &members, const std::string &primary, const J &options, const Limits &limits, const J &memberNames = J()) {
	AssayClock clock; J recipe = assay_recipe(options); bool surface = recipe.get("mode").str() == "surface";
	std::string companion = lower(recipe.get("collars").get("member").str());
	if ((surface && members.size() != 1) || (!surface && (members.size() != 2 || companion == primary || !members.count(companion)))) reject("gis_bundle_invalid", "Assay recipe must bind exactly the primary and its declared collar companion.");
	for (const auto &[name, bytes] : members) { (void)bytes; std::string ext = name.substr(name.find_last_of('.') + 1); if (ext != "csv" && ext != "tsv") reject("gis_format_unsupported", "Assay members must be captured CSV or TSV tables."); }
	auto original = [&](const std::string &name) { return memberNames.has(name.c_str()) ? memberNames.get(name.c_str()).str() : name; };
	if (!surface && original(companion) != recipe.get("collars").get("member").str()) reject("gis_bundle_invalid", "Collar recipe must name the exact captured member basename.");
	AssayTable table(original(primary), members.at(primary), limits, clock); J columns = recipe.get("columns");
	table.columns(columns, {"id", "hole", "x", "y", "from", "to", "analyte", "qualifier"});
	J tables = J::array(), rows = J::array(), collarRows = J::array(), points = J::array(); tables.add(table.metadata());
	std::map<std::string, int64_t> counts; for (const auto *key : {"dataRows", "collarRows", "points", "mapped", "unmapped", "detected", "censored", "missing", "invalid", "duplicateCollarIds", "duplicateCollarRows", "unmatchedRows", "ambiguousRows", "invalidDepthRows", "outsideWindowRows", "invalidCoordinateRows", "missingIdRows"}) counts[key] = 0;
	counts["dataRows"] = table.records.size(); std::map<std::string, J> diagnostics;
	auto diagnostic = [&](const std::string &code, const std::string &locator) { if (!diagnostics.count(code)) diagnostics[code] = J::array(); diagnostics[code].add(locator); };
	std::vector<std::pair<std::string, Geometry>> geometries;
	auto coordinates = [&](const std::string &x, const std::string &y, const std::string &locator) -> Geometry { double a, b; if (!assay_number(assay_trim(x), a) || !assay_number(assay_trim(y), b)) { counts["invalidCoordinateRows"]++; diagnostic("invalid-coordinate", locator); return nullptr; } return Geometry(new OGRPoint(a, b)); };
	auto point = [&](J item, const OGRGeometry *geometry, const J &value, const J &contributors, const J &maximum, const char *meaning) {
		if (points.size() >= limits.assayPoints) reject("assay_point_limit", "Assay points exceed their ceiling.");
		GeometryBudget budget{0, 0, limits}; item.set("geometry", geometry_json(geometry, budget)); item.set("value", value); item.set("rowLocators", contributors); item.set("maximumLocators", maximum); item.set("locationMeaning", meaning); points.add(item); geometries.emplace_back(item.get("locator").str(), geometry->clone());
	};
	struct Collar { J row; Geometry geometry; std::vector<size_t> contributors; };
	std::vector<Collar> collars; std::map<std::string, std::vector<size_t>> byHole;
	if (!surface) {
		AssayTable collarTable(original(companion), members.at(companion), limits, clock); J cc = recipe.get("collars").get("columns"); collarTable.columns(cc, {"hole", "x", "y"}); tables.add(collarTable.metadata()); counts["collarRows"] = collarTable.records.size();
		for (size_t n = 0; n < collarTable.records.size(); n++) {
			clock.check(); J row = collarTable.lineage(n), raw = J::object(); std::string id = assay_trim(collarTable.cell(n, cc, "hole")), locator = row.get("locator").str();
			raw.set("hole", collarTable.cell(n, cc, "hole")); raw.set("x", collarTable.cell(n, cc, "x")); raw.set("y", collarTable.cell(n, cc, "y")); row.set("raw", raw); row.set("id", id); row.set("duplicate", false);
			auto geometry = coordinates(raw.get("x").str(), raw.get("y").str(), locator); GeometryBudget budget{0, 0, limits}; row.set("geometry", geometry_json(geometry.get(), budget));
			if (id.empty()) { counts["missingIdRows"]++; diagnostic("missing-id", locator); } else byHole[id].push_back(n);
			collarRows.add(row); collars.push_back({row, std::move(geometry), {}});
		}
		for (const auto &[id, indices] : byHole) { (void)id; if (indices.size() > 1) { counts["duplicateCollarIds"]++; counts["duplicateCollarRows"] += indices.size(); for (auto index : indices) { collars[index].row.set("duplicate", true); diagnostic("duplicate-collar-id", collars[index].row.get("locator").str()); } } }
	}
	for (size_t n = 0; n < table.records.size(); n++) {
		clock.check(); J row = table.lineage(n), raw = J::object(); auto locator = row.get("locator").str();
		std::string id = assay_trim(table.cell(n, columns, surface ? "id" : "hole")); row.set("id", id);
		for (auto key : {"id", "hole", "x", "y", "from", "to", "analyte", "qualifier"}) if (columns.has(key) || std::string(key) == "qualifier") raw.set(key, table.cell(n, columns, key)); row.set("raw", raw);
		J value = assay_value(raw.get("analyte").str(), raw.get("qualifier").str(), recipe.get("numbers")); row.set("value", value); counts[value.get("state").str()]++;
		if (value.get("state").str() == "invalid") diagnostic("invalid-value", locator);
		if (id.empty()) { counts["missingIdRows"]++; diagnostic("missing-id", locator); }
		if (surface) {
			row.set("joinState", "surface"); row.set("depth", J()); auto geometry = coordinates(raw.get("x").str(), raw.get("y").str(), locator);
			if (geometry && !id.empty()) { J item = table.lineage(n); item.set("id", id); point(item, geometry.get(), value, strings({locator}), value.get("state").str() == "detected" ? strings({locator}) : J::array(), "surface-sample"); }
		} else {
			double from = 0, to = 0; bool valid = assay_number(assay_trim(raw.get("from").str()), from) && assay_number(assay_trim(raw.get("to").str()), to) && from >= 0 && to > from;
			J window = recipe.get("depthWindow"); bool included = valid && (window.get("kind").str() == "whole-hole" || (to > window.get("from").number() && from < window.get("to").number()));
			J depth = J::object(); depth.set("from", valid ? J(from) : J()); depth.set("to", valid ? J(to) : J()); depth.set("valid", valid); depth.set("inWindow", included); row.set("depth", depth);
			if (!valid) { counts["invalidDepthRows"]++; diagnostic("invalid-depth", locator); } else if (!included) { counts["outsideWindowRows"]++; diagnostic("outside-depth-window", locator); }
			auto found = byHole.find(id); std::string join = id.empty() ? "missing-id" : found == byHole.end() ? "unmatched" : found->second.size() > 1 ? "ambiguous" : "matched"; row.set("joinState", join);
			if (join == "unmatched") { counts["unmatchedRows"]++; diagnostic("unmatched-hole", locator); }
			if (join == "ambiguous") { counts["ambiguousRows"]++; diagnostic("ambiguous-hole", locator); }
			if (join == "matched" && included) collars[found->second[0]].contributors.push_back(n);
		}
		rows.add(row);
	}
	if (!surface) for (const auto &collar : collars) {
		clock.check(); if (collar.row.get("duplicate").boolean() || !collar.geometry || collar.row.get("id").str().empty()) continue;
		bool detected = false, censored = false, invalid = false; double maximum = 0; J contributors = J::array(), maxima = J::array();
		for (auto index : collar.contributors) { J row = rows.at(index), value = row.get("value"); auto state = value.get("state").str(); contributors.add(row.get("locator")); censored |= state == "censored"; invalid |= state == "invalid";
			if (state == "detected") { double number = value.get("value").number(); if (!detected || number > maximum) { maximum = number; maxima = J::array(); } if (!detected || number >= maximum) maxima.add(row.get("locator")); detected = true; }
		}
		J value = J::object(); value.set("state", detected ? "detected" : invalid ? "invalid" : censored ? "all-censored" : "missing"); value.set("value", detected ? J(maximum) : J()); value.set("qualifier", J());
		J item = J::object(); for (auto key : {"memberName", "recordOrdinal", "locator", "id"}) item.set(key, collar.row.get(key)); point(item, collar.geometry.get(), value, contributors, maxima, "collar-summary");
	}
	// A Memory layer supplies Placement's metadata interface; no CSV/GDAL inference
	// or live pathname is involved in assay parsing or source CRS selection.
	auto *driver = GetGDALDriverManager()->GetDriverByName("Memory"); if (!driver) reject("worker_unavailable", "Installed GDAL Memory layer is unavailable.");
	Dataset dataset(driver->Create("", 0, 0, 0, GDT_Unknown, nullptr), GDALClose); if (!dataset) reject("gis_resource_limit", "Assay placement metadata could not be allocated."); auto *layer = dataset->CreateLayer("assay", nullptr, wkbPoint, nullptr); if (!layer) reject("gis_resource_limit", "Assay placement layer could not be allocated.");
	J displayOptions = J::object(), assumed = J::object(); assumed.set("layerId", "layer-0"); assumed.set("code", recipe.get("sourceCrs").get("code")); assumed.set("axisOrder", recipe.get("sourceCrs").get("axisOrder")); displayOptions.set("sourceCrs", assumed); displayOptions.set("allowApproximate", recipe.get("allowApproximate"));
	Placement placement(layer, "layer-0", displayOptions, false, true); clock.check(); placement.prepare(geometries);
	for (const auto &[locator, geometry] : geometries) { clock.check(); placement.feature(geometry.get(), locator, limits); if (!placement.display.has(locator.c_str())) diagnostic("unplaced-point", locator); }
	J placed = placement.finish(points.size()); counts["points"] = points.size(); counts["mapped"] = placed.get("coverage").get("displayed").integer(); counts["unmapped"] = points.size() - counts["mapped"];
	J countJson = J::object(), diagnosticJson = J::array(); for (const auto &[key, value] : counts) countJson.set(key, value); for (const auto &[code, locators] : diagnostics) { J item = J::object(); item.set("code", code); item.set("locators", locators); diagnosticJson.add(item); }
	J result = J::object(); result.set("schemaVersion", 1); result.set("kind", "assay"); result.set("parser", ASSAY_PARSER); result.set("recipe", recipe); result.set("unit", recipe.get("unit")); result.set("summaryRule", surface ? "source-value" : "maximum-detected"); result.set("tables", tables); result.set("rows", rows); result.set("collarRows", collarRows); result.set("points", points); result.set("counts", countJson); result.set("diagnostics", diagnosticJson); result.set("placement", placed); result.set("operationFingerprint", assay_hash(placed.get("environmentFingerprint").str() + "\n" + placed.get("sourceFrame").dump() + "\n" + placed.get("operation").dump())); result.set("coverage", "Complete captured assay records within advertised limits; native points and CRS84 placement have separate coverage."); result.set("warnings", J::array());
	J bounds = J::object(); bounds.set("inputBytes", limits.inputBytes); bounds.set("rowsPerTable", limits.assayRows); bounds.set("points", limits.assayPoints); bounds.set("columns", limits.assayColumns); bounds.set("cellBytes", limits.assayCellBytes); bounds.set("manifestBytes", limits.assayManifestBytes); bounds.set("responseBytes", limits.assayResponseBytes); bounds.set("timeoutMs", 30000); result.set("limits", bounds);
	clock.check(); auto size = static_cast<int64_t>(result.dump().size()); if (size > limits.assayManifestBytes) reject("assay_manifest_limit", "Complete assay metadata exceeds the manifest ceiling."); if (size > limits.assayResponseBytes) reject("assay_response_limit", "Complete assay metadata exceeds the response ceiling."); return result;
}
static void assay_qualify(J &probe) {
	const std::string text = "ID,X,Y,Au,Q\n\"s,α\",10,30,<0.1,<\nsecond,11,31,2,=\n"; Members members{{"samples.csv", Bytes(text.begin(), text.end())}};
	J recipe = J::parse("{\"mode\":\"surface\",\"columns\":{\"id\":\"ID\",\"x\":\"X\",\"y\":\"Y\",\"analyte\":\"Au\",\"qualifier\":\"Q\"},\"sourceCrs\":{\"code\":\"OGC:CRS84\",\"axisOrder\":\"xy\"},\"unit\":{\"name\":\"ppm\",\"basis\":\"user-assigned\"}}");
	J result = assay_process(members, "samples.csv", recipe, Limits()); if (result.get("rows").size() != 2 || result.get("rows").at(0).get("value").get("state").str() != "censored" || result.get("placement").get("state").str() != "ready" || result.get("placement").get("displayByLocator").get("samples.csv:2").get("coordinates").at(0).number() != 10) reject("worker_unavailable", "Installed assay parser/placement probe failed.");
	const std::string assays = "Hole,From,To,Au\nA,0,10,2\nA,10,20,999\n", collars = "Hole\tX\tY\nA\t10\t30\n";
	Members joined{{"assays.csv", Bytes(assays.begin(), assays.end())}, {"collars.tsv", Bytes(collars.begin(), collars.end())}};
	J joinedRecipe = J::parse("{\"mode\":\"collar-summary\",\"columns\":{\"hole\":\"Hole\",\"from\":\"From\",\"to\":\"To\",\"analyte\":\"Au\"},\"collars\":{\"member\":\"collars.tsv\",\"columns\":{\"hole\":\"Hole\",\"x\":\"X\",\"y\":\"Y\"}},\"sourceCrs\":{\"code\":\"OGC:CRS84\",\"axisOrder\":\"xy\"},\"unit\":{\"name\":\"ppm\",\"basis\":\"source-declared\"},\"depthUnit\":\"m\",\"depthWindow\":{\"kind\":\"range\",\"from\":0,\"to\":10}}");
	J summary = assay_process(joined, "assays.csv", joinedRecipe, Limits()); if (summary.get("points").size() != 1 || summary.get("points").at(0).get("value").get("value").number() != 2 || summary.get("points").at(0).get("rowLocators").size() != 1) reject("worker_unavailable", "Installed TSV collar/window probe failed.");
	for (const auto &malformed : {std::string("ID,X,Y,Au,Q\na,10,30,\"unterminated,\n"), std::string(1, static_cast<char>(0xff))}) {
		bool refused = false; try { Members bad{{"samples.csv", Bytes(malformed.begin(), malformed.end())}}; assay_process(bad, "samples.csv", recipe, Limits()); } catch (const Failure &failure) { refused = failure.reason == "assay_table_invalid"; }
		if (!refused) reject("worker_unavailable", "Installed assay malformed-text denial probe failed.");
	}
	probe.set("assay", ASSAY_PARSER);
}
