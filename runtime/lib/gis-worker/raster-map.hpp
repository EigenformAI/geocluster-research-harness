#pragma once

// Placement consumes a layer's frame; raster placement supplies densified
// pixel-edge geometry instead. No vector driver or external dataset is needed.
class RasterMapFrame final : public OGRLayer {
	OGRSpatialReference *srs;
public:
	explicit RasterMapFrame(OGRSpatialReference *frame) : srs(frame) {}
	OGRSpatialReference *GetSpatialRef() override { return srs; }
	void ResetReading() override {}
	OGRFeature *GetNextFeature() override { return nullptr; }
	OGRFeatureDefn *GetLayerDefn() override { return nullptr; }
	int TestCapability(const char *) override { return FALSE; }
};

using RasterMapTransform = std::unique_ptr<OGRCoordinateTransformation, decltype(&OCTDestroyCoordinateTransformation)>;
static constexpr const char *RASTER_MAP_MERCATOR = "+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=webmerc +ellps=WGS84";
static constexpr double RASTER_MAP_LATITUDE = 85.0511287798066;

static void raster_map_domain(double x, double y) {
	if (!std::isfinite(x) || !std::isfinite(y) || x < -180 || x > 180 || y < -RASTER_MAP_LATITUDE || y > RASTER_MAP_LATITUDE)
		reject("gis_display_domain", "Raster coordinates are outside the finite Web Mercator longitude/latitude domain. Check the source CRS and axis order.");
}

struct RasterMapBlocks {
	GDALRasterBand *band;
	int width, blockWidth, blockHeight, bytesPerSample;
	int64_t columns, blockBytes;
	std::vector<std::pair<int64_t, size_t>> samples;
	int64_t blocks = 0;
	RasterMapBlocks(GDALRasterBand *b, const std::vector<int64_t> &cells) : band(b), width(b->GetXSize()), bytesPerSample(GDALGetDataTypeSizeBytes(b->GetRasterDataType())) {
		b->GetBlockSize(&blockWidth, &blockHeight); columns = (int64_t(width) + blockWidth - 1) / blockWidth; blockBytes = int64_t(blockWidth) * blockHeight * bytesPerSample;
		for (size_t i = 0; i < cells.size(); i++) if (cells[i] >= 0) {
			int64_t x = cells[i] % width, y = cells[i] / width;
			samples.emplace_back((y / blockHeight) * columns + x / blockWidth, i);
		}
		std::sort(samples.begin(), samples.end()); int64_t previous = -1;
		for (const auto &[key, index] : samples) { (void)index; if (key != previous) { blocks++; previous = key; } }
	}
	void read(const std::vector<int64_t> &cells, std::vector<double> &values) const {
		// Read every touched base-level block exactly once. Sorting avoids relying
		// on GDAL cache residency, and never invokes auto overview selection.
		if (samples.empty()) return;
		Bytes buffer(static_cast<size_t>(blockBytes)); int64_t previous = -1;
		for (const auto &[key, index] : samples) {
			if (key != previous) {
				if (band->ReadBlock(static_cast<int>(key % columns), static_cast<int>(key / columns), buffer.data()) != CE_None) reject("gis_decode_failed", "A selected raster or independent mask block could not be decoded.");
				previous = key;
			}
			int64_t x = cells[index] % width, y = cells[index] / width, offset = ((y % blockHeight) * blockWidth + x % blockWidth) * bytesPerSample;
			GDALCopyWords(buffer.data() + offset, band->GetRasterDataType(), 0, &values[index], GDT_Float64, 0, 1);
		}
	}
};

static J raster_map_metadata(GDALDataset *ds, const Limits &limits) {
	J metadata = J::array(); int64_t expanded = 0;
	// Use the preview's band interpretation and physical block validation.
	for (int i = 1; i <= ds->GetRasterCount(); i++) {
		auto *b = ds->GetRasterBand(i); if (!b || !b->GetMaskBand()) reject("gis_decode_failed", "Raster band or mask is unavailable.");
		block_budget(b, limits); block_budget(b->GetMaskBand(), limits); int x, y; b->GetBlockSize(&x, &y); expanded += int64_t(x) * y * std::max(1, GDALGetDataTypeSizeBytes(b->GetRasterDataType()));
		if (expanded > limits.decodedBlockBytes) reject("raster_block_limit", "Combined expanded raster blocks exceed their ceiling.");
		J j = J::object(); int valid; j.set("nodata", band_nodata(b)); double n = b->GetScale(&valid); j.set("scale", valid ? numeric(n) : J()); n = b->GetOffset(&valid); j.set("offset", valid ? numeric(n) : J());
		j.set("band", i); j.set("description", b->GetDescription()); j.set("dataType", GDALGetDataTypeName(b->GetRasterDataType())); j.set("unit", std::strlen(b->GetUnitType()) ? J(b->GetUnitType()) : J()); j.set("colorInterpretation", GDALGetColorInterpretationName(b->GetColorInterpretation())); j.set("colorTableEntries", b->GetColorTable() ? b->GetColorTable()->GetColorEntryCount() : 0); j.set("maskFlags", mask_flags(b->GetMaskFlags()));
		J overviews = J::array(); for (int k = 0; k < b->GetOverviewCount(); k++) { J o = J::object(); o.set("width", b->GetOverview(k)->GetXSize()); o.set("height", b->GetOverview(k)->GetYSize()); overviews.add(o); } j.set("overviews", overviews); metadata.add(j);
		response_bound(metadata, limits, "gis_response_limit");
	}
	return metadata;
}

static J raster_map_display(GDALDataset *ds, const J &options, const Limits &limits, const Bytes &captured) {
	if (std::strcmp(ds->GetDriverName(), "ERS") == 0) {
		// The installed ERS driver ignores CoordinateSpace.Rotation when forming
		// its affine transform. A nonzero/unknown rotation cannot become ready
		// north-up imagery simply because GDAL returned a north-up transform.
		std::string header = member_text(captured); std::regex rotation("\\bRotation[ \\t]*=[ \\t]*([^\\r\\n]*)", std::regex::icase);
		for (std::sregex_iterator it(header.begin(), header.end(), rotation), end; it != end; ++it)
			if (!std::regex_match((*it)[1].str(), std::regex("[ \\t]*[\"]?[+-]?0+(?:\\.0+)?(?::[+-]?0+(?:\\.0+)?){0,2}[\"]?[ \\t]*"))) reject("gis_georeference_required", "The installed ERS decoder does not apply this declared rotation. Supply a raster with a supported affine geotransform.");
	}
	int width = ds->GetRasterXSize(), height = ds->GetRasterYSize(), bands = ds->GetRasterCount();
	if (width < 1 || height < 1 || int64_t(width) * height > limits.sourcePixels) reject("raster_pixel_limit", "Raster source dimensions exceed the pixel ceiling.");
	if (bands < 1 || bands > limits.bands) reject("raster_band_limit", "Raster band count exceeds its ceiling.");
	int selected = static_cast<int>(option_integer(options, "band", 1, 1, bands));
	J displayOptions = options.get("displayOptions"); if (displayOptions.null()) displayOptions = J::object();
	if (!displayOptions.is(json_type_object)) reject("gis_invalid_options", "Raster display options must be an object.");
	J suppliedEnvironment = displayOptions.get("environmentFingerprint");
	if (!suppliedEnvironment.null() && (!suppliedEnvironment.is(json_type_string) || suppliedEnvironment.str() != fingerprint)) reject("gis_environment_changed", "Raster display options refer to a different installed projection environment.");
	J placementOptions = J::object(); placementOptions.set("allowApproximate", displayOptions.get("allowApproximate"));
	J assumption = displayOptions.get("sourceCrs");
	if (!assumption.null()) {
		if (!assumption.is(json_type_object) || !std::regex_match(assumption.get("code").str(), std::regex("EPSG:[1-9][0-9]{0,6}|OGC:CRS84")) || (assumption.get("axisOrder").str() != "xy" && assumption.get("axisOrder").str() != "yx")) reject("gis_invalid_options", "Raster source CRS assumptions require an installed authority code and explicit XY or YX order.");
		J mapped = J::object(); mapped.set("layerId", "layer-0"); mapped.set("code", assumption.get("code")); mapped.set("axisOrder", assumption.get("axisOrder")); placementOptions.set("sourceCrs", mapped);
	}
	double gt[6], inverseGt[6];
	if (ds->GetGeoTransform(gt) != CE_None) reject("gis_georeference_required", "Raster map display requires a source affine geotransform.");
	J geoTransform = J::array(); for (double v : gt) { if (!std::isfinite(v)) reject("gis_metadata_invalid", "Native raster geotransform contains a nonfinite value."); geoTransform.add(v); }
	if (!GDALInvGeoTransform(gt, inverseGt)) reject("gis_metadata_invalid", "Raster source affine geotransform is singular.");
	RasterMapFrame frame(const_cast<OGRSpatialReference *>(ds->GetSpatialRef())); Placement placement(&frame, "layer-0", placementOptions, false, false);
	if (!placement.source) reject("gis_source_crs_unknown", "Raster source CRS is unknown. Supply a source CRS and axis order for map display.");
	if ((!placement.source->IsGeographic() && !placement.source->IsProjected()) || placement.source->GetAxesCount() != 2) reject("gis_invalid_options", "Raster map display requires a two-dimensional geographic or projected source CRS.");
	J metadata = raster_map_metadata(ds, limits); auto *band = ds->GetRasterBand(selected);
	if (GDALDataTypeIsComplex(band->GetRasterDataType()) || band->GetRasterDataType() == GDT_Int64 || band->GetRasterDataType() == GDT_UInt64) reject("raster_type_unsupported", "Complex and 64-bit integer samples require a display treatment outside this Float64 grayscale display.");

	// Densify actual pixel edges, not their native axis-aligned bounding box.
	// Interior checkpoints also establish the operation AOI and detect domains.
	constexpr int segments = 128; OGRLineString boundary; OGRMultiPoint interior;
	auto point = [&](double pixel, double line) { double x, y; GDALApplyGeoTransform(gt, pixel, line, &x, &y); if (!std::isfinite(x) || !std::isfinite(y)) reject("gis_metadata_invalid", "Raster source footprint contains nonfinite coordinates."); return OGRPoint(x, y); };
	for (int edge = 0; edge < 4; edge++) for (int n = 0; n < segments; n++) {
		double fraction = double(n) / segments, pixel = edge == 0 ? width * fraction : edge == 1 ? width : edge == 2 ? width * (1 - fraction) : 0;
		double line = edge == 0 ? 0 : edge == 1 ? height * fraction : edge == 2 ? height : height * (1 - fraction);
		auto p = point(pixel, line); boundary.addPoint(&p);
	}
	boundary.addPoint(boundary.getX(0), boundary.getY(0));
	for (int y = 1; y < 16; y++) for (int x = 1; x < 16; x++) { auto p = point(width * double(x) / 16, height * double(y) / 16); interior.addGeometry(&p); }
	std::vector<std::pair<std::string, Geometry>> geometry; geometry.emplace_back("boundary", boundary.clone()); geometry.emplace_back("interior", interior.clone()); placement.prepare(geometry);
	if (!placement.transform) {
		std::string reasons; for (int i = 0; i < placement.reasons.size(); i++) { if (i) reasons += " "; reasons += placement.reasons.at(i).str(); }
		bool domain = reasons.find("outside") != std::string::npos;
		reject(domain ? "gis_display_domain" : "gis_transformation_unavailable", reasons.empty() ? "No applicable installed raster transformation is available." : reasons);
	}
	RasterMapTransform inverse(placement.transform->GetInverse(), OCTDestroyCoordinateTransformation);
	if (!inverse) reject("gis_transformation_unavailable", "The selected source coordinate operation has no usable inverse for raster placement.");
	OGRSpatialReference mercator; mercator.SetFromUserInput("EPSG:3857"); mercator.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
	OGRCoordinateTransformationOptions conversionOptions; conversionOptions.SetBallparkAllowed(false); conversionOptions.SetCoordinateOperation(RASTER_MAP_MERCATOR, false);
	RasterMapTransform conversion(OGRCreateCoordinateTransformation(&placement.target, &mercator, conversionOptions), OCTDestroyCoordinateTransformation);
	RasterMapTransform unproject(conversion ? conversion->GetInverse() : nullptr, OCTDestroyCoordinateTransformation);
	if (!conversion || !unproject) reject("gis_transformation_unavailable", "Installed Web Mercator display conversion is unavailable.");
	OGREnvelope bounds; bool hasBounds = false; J ring = J::array(); double previousLongitude = 0;
	auto forward = [&](double x, double y, bool edge) {
		if (!placement.transform->Transform(1, &x, &y)) reject("gis_display_domain", "A raster footprint point could not be transformed by the selected coordinate operation.");
		raster_map_domain(x, y);
		if (edge && ring.size() && std::abs(x - previousLongitude) > 180) reject("gis_display_domain", "Raster footprint crosses the Web Mercator longitude discontinuity.");
		previousLongitude = x;
		if (!conversion->Transform(1, &x, &y) || !std::isfinite(x) || !std::isfinite(y)) reject("gis_display_domain", "Raster footprint cannot be converted to finite Web Mercator coordinates.");
		OGREnvelope e; e.MinX = e.MaxX = x; e.MinY = e.MaxY = y; if (!hasBounds) { bounds = e; hasBounds = true; } else bounds.Merge(e);
		if (edge) { J p = J::array(); p.add(x); p.add(y); ring.add(p); }
	};
	for (int i = 0; i < boundary.getNumPoints(); i++) forward(boundary.getX(i), boundary.getY(i), true);
	for (int i = 0; i < interior.getNumGeometries(); i++) { auto *p = interior.getGeometryRef(i); forward(p->getX(), p->getY(), false); }
	double spanX = bounds.MaxX - bounds.MinX, spanY = bounds.MaxY - bounds.MinY;
	if (!std::isfinite(spanX) || !std::isfinite(spanY) || spanX <= 0 || spanY <= 0) reject("gis_display_domain", "Raster has no finite nonzero Web Mercator extent.");
	int outWidth = std::max(1, static_cast<int>(std::round(limits.previewEdge * spanX / std::max(spanX, spanY))));
	int outHeight = std::max(1, static_cast<int>(std::round(limits.previewEdge * spanY / std::max(spanX, spanY)))); size_t pixels = size_t(outWidth) * outHeight;
	std::vector<int64_t> cells(pixels, -1); std::vector<double> xs(outWidth), ys(outWidth); std::vector<int> valid(outWidth);
	int64_t sampled = 0;
	for (int row = 0; row < outHeight; row++) {
		for (int column = 0; column < outWidth; column++) { xs[column] = bounds.MinX + (column + 0.5) * spanX / outWidth; ys[column] = bounds.MaxY - (row + 0.5) * spanY / outHeight; }
		if (!unproject->Transform(outWidth, xs.data(), ys.data(), nullptr, valid.data())) reject("gis_display_domain", "A raster output pixel cannot be inverse-projected from Web Mercator.");
		for (int column = 0; column < outWidth; column++) { if (!valid[column]) reject("gis_display_domain", "Raster inverse display conversion failed."); raster_map_domain(xs[column], ys[column]); }
		if (!inverse->Transform(outWidth, xs.data(), ys.data(), nullptr, valid.data())) reject("gis_display_domain", "A raster output pixel cannot be mapped through the exact inverse selected operation.");
		for (int column = 0; column < outWidth; column++) {
			if (!valid[column] || !std::isfinite(xs[column]) || !std::isfinite(ys[column])) reject("gis_display_domain", "Selected inverse operation returned an invalid raster source position.");
			double x, y; GDALApplyGeoTransform(inverseGt, xs[column], ys[column], &x, &y);
			if (!std::isfinite(x) || !std::isfinite(y)) reject("gis_display_domain", "Inverse affine mapping returned a nonfinite raster pixel position.");
			if (x >= 0 && y >= 0 && x < width && y < height) { cells[size_t(row) * outWidth + column] = int64_t(std::floor(y)) * width + int64_t(std::floor(x)); sampled++; }
		}
	}
	RasterMapBlocks sourceBlocks(band, cells); auto *mask = band->GetMaskBand();
	// Nodata-derived masks reread the band: evaluate that exact rule directly.
	// Independent masks/alpha still have a separate bounded block read.
	bool independentMask = !(band->GetMaskFlags() & GMF_ALL_VALID) && band->GetMaskFlags() != GMF_NODATA;
	RasterMapBlocks maskBlocks(mask, independentMask ? cells : std::vector<int64_t>());
	int64_t decodedBytes = (sourceBlocks.blocks * sourceBlocks.blockBytes + maskBlocks.blocks * maskBlocks.blockBytes) * bands;
	if (decodedBytes > limits.decodedBlockBytes) reject("raster_block_limit", "Total expanded positioned raster and mask block work exceeds its ceiling.");
	std::vector<double> values(pixels), masks(pixels, 255); sourceBlocks.read(cells, values); if (independentMask) maskBlocks.read(cells, masks);
	int hasNodata; double nodata = band->GetNoDataValue(&hasNodata), minimum = std::numeric_limits<double>::infinity(), maximum = -minimum; int64_t visible = 0;
	for (size_t i = 0; i < pixels; i++) {
		if (cells[i] < 0 || !std::isfinite(values[i]) || (hasNodata && (std::isnan(nodata) ? std::isnan(values[i]) : values[i] == nodata))) masks[i] = 0;
		if (masks[i] > 0) { visible++; minimum = std::min(minimum, values[i]); maximum = std::max(maximum, values[i]); }
	}
	Bytes rgba(pixels * 4);
	for (size_t i = 0; i < pixels; i++) {
		unsigned char grey = masks[i] > 0 && maximum > minimum ? static_cast<unsigned char>(std::round(255.0L * std::clamp((static_cast<long double>(values[i]) - minimum) / (static_cast<long double>(maximum) - minimum), 0.0L, 1.0L))) : 0;
		rgba[i*4] = rgba[i*4+1] = rgba[i*4+2] = grey; rgba[i*4+3] = static_cast<unsigned char>(std::clamp(masks[i], 0.0, 255.0));
	}
	Dataset image(GetGDALDriverManager()->GetDriverByName("MEM")->Create("", outWidth, outHeight, 4, GDT_Byte, nullptr), GDALClose); if (!image) reject("gis_resource_limit", "Raster map PNG memory allocation failed.");
	for (int i = 0; i < 4; i++) { image->GetRasterBand(i+1)->SetColorInterpretation(static_cast<GDALColorInterp>(GCI_RedBand + i)); if (image->GetRasterBand(i+1)->RasterIO(GF_Write, 0, 0, outWidth, outHeight, rgba.data()+i, outWidth, outHeight, GDT_Byte, 4, outWidth*4) != CE_None) reject("gis_decode_failed", "Raster map PNG channel generation failed."); }
	Dataset png(GetGDALDriverManager()->GetDriverByName("PNG")->CreateCopy("/vsimem/raster-map.png", image.get(), FALSE, nullptr, nullptr, nullptr), GDALClose); if (!png) reject("gis_decode_failed", "Raster map PNG encoding failed."); png.reset();
	vsi_l_offset bytes; auto *encoded = VSIGetMemFileBuffer("/vsimem/raster-map.png", &bytes, FALSE); if (!encoded || bytes > static_cast<uint64_t>(limits.responseBytes)) reject("gis_response_limit", "Raster map PNG exceeds its response ceiling.");
	char *base64 = CPLBase64Encode(static_cast<int>(bytes), encoded); std::string url = "data:image/png;base64," + std::string(base64); CPLFree(base64); VSIUnlink("/vsimem/raster-map.png");
	J result = J::object(); result.set("schemaVersion", 1); result.set("parser", "bounded-gdal-raster-map-v1"); result.set("kind", "raster-map-display"); result.set("state", "ready"); result.set("driver", ds->GetDriverName()); result.set("driverVersion", GDALVersionInfo("RELEASE_NAME")); result.set("width", width); result.set("height", height); result.set("bandCount", bands); result.set("bands", metadata); result.set("crsWkt", wkt(const_cast<OGRSpatialReference *>(ds->GetSpatialRef()))); result.set("geoTransform", geoTransform); result.set("sourceFrame", placement.json.get("sourceFrame")); result.set("displayOptions", displayOptions);
	result.set("displayCrs", "EPSG:3857"); result.set("extent", extent(bounds)); J footprint = J::object(), coordinates = J::array(); coordinates.add(ring); footprint.set("type", "Polygon"); footprint.set("coordinates", coordinates); result.set("footprint", footprint);
	J operation = placement.json.get("operation"), displayConversion = J::object(); operation.set("sourceTargetCrs", "OGC:CRS84"); operation.set("inverse", "Exact inverse of the selected source operation"); displayConversion.set("identity", "EPSG:3856 (Popular Visualisation Pseudo-Mercator)"); displayConversion.set("sourceCrs", "OGC:CRS84"); displayConversion.set("targetCrs", "EPSG:3857"); displayConversion.set("pipeline", RASTER_MAP_MERCATOR); operation.set("displayConversion", displayConversion); result.set("operation", operation); result.set("environmentFingerprint", fingerprint);
	J environment = J::object(); environment.set("gdal", GDALVersionInfo("RELEASE_NAME")); environment.set("proj", proj_info().version); environment.set("fingerprint", fingerprint); environment.set("networkEnabled", false); result.set("environment", environment);
	J im = J::object(), stretch = J::object(); stretch.set("kind", "sample-min-max"); stretch.set("label", "Display stretch"); stretch.set("minimum", visible ? J(minimum) : J()); stretch.set("maximum", visible ? J(maximum) : J()); im.set("band", selected); im.set("width", outWidth); im.set("height", outHeight); im.set("dataUrl", url); im.set("resampling", "nearest"); im.set("overviewSelection", "base-resolution"); im.set("stretch", stretch); im.set("scaleOffsetApplied", false); im.set("colorTableApplied", false); result.set("image", im);
	J coverage = J::object(); coverage.set("outputPixels", static_cast<int64_t>(pixels)); coverage.set("sampledSourcePixels", sampled); coverage.set("visiblePixels", visible); coverage.set("transparentPixels", static_cast<int64_t>(pixels) - visible); coverage.set("decodedBlockBytes", decodedBytes); coverage.set("footprintEdgeSegments", segments); result.set("coverage", coverage);
	J caps = J::object(); caps.set("inputBytes", limits.inputBytes); caps.set("bands", limits.bands); caps.set("previewEdge", limits.previewEdge); caps.set("sourcePixels", limits.sourcePixels); caps.set("decodedBlockBytes", limits.decodedBlockBytes); caps.set("outputBytes", limits.responseBytes); caps.set("memoryBytes", 512 * MIB); caps.set("timeoutMs", 30000); result.set("limits", caps);
	result.set("warnings", strings({"Display stretch uses sampled selected-band values, not a numerical source-value legend. Band scale, offset, and color table are not applied."})); response_bound(result, limits, "gis_response_limit"); return result;
}
