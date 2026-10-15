#include <gdal_priv.h>
#include <ogr_spatialref.h>
#include <array>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>

// Build/test-only producer: every raster is written by a genuine GDAL driver.
static void check(CPLErr result) { if (result != CE_None) throw std::runtime_error("fixture write failed"); }
static void raster(const std::string &directory, const char *name, int epsg, std::array<double, 6> gt, bool mask = false, bool georeferenced = true) {
	const auto filename = directory + "/" + name;
	auto *ds = GetGDALDriverManager()->GetDriverByName("GTiff")->Create(filename.c_str(), 4, 4, 2, GDT_UInt16, nullptr);
	if (!ds) throw std::runtime_error("fixture create failed");
	if (georeferenced) check(ds->SetGeoTransform(gt.data()));
	if (epsg) { OGRSpatialReference srs; if (srs.importFromEPSG(epsg) != OGRERR_NONE) throw std::runtime_error("fixture CRS failed"); check(ds->SetSpatialRef(&srs)); }
	for (int b = 1; b <= 2; b++) {
		std::array<unsigned short, 16> values{};
		for (int i = 0; i < 16; i++) values[i] = b == 1 ? 10 + i * 10 : 310 - i * 20;
		values[15] = 65535;
		auto *band = ds->GetRasterBand(b); check(band->SetNoDataValue(65535)); check(band->SetScale(2)); check(band->SetOffset(100)); check(band->SetUnitType("nT")); band->SetDescription(b == 1 ? "increasing" : "decreasing");
		check(band->RasterIO(GF_Write, 0, 0, 4, 4, values.data(), 4, 4, GDT_UInt16, 0, 0));
	}
	if (mask) {
		check(ds->GetRasterBand(1)->CreateMaskBand(GMF_PER_DATASET));
		std::array<unsigned char, 16> values{}; values.fill(255); values[5] = 0;
		check(ds->GetRasterBand(1)->GetMaskBand()->RasterIO(GF_Write, 0, 0, 4, 4, values.data(), 4, 4, GDT_Byte, 0, 0));
	}
	GDALClose(ds);
}

int main(int argc, char **argv) {
	if (argc != 2) return 2;
	GDALAllRegister(); CPLSetConfigOption("GDAL_TIFF_INTERNAL_MASK", "YES");
	std::filesystem::create_directories(argv[1]); const std::string directory = argv[1];
	raster(directory, "rotated.tif", 3857, {13000000, 1000, 700, -3000000, 700, -1000}, true);
	raster(directory, "sheared.tif", 4326, {120, 0.04, 0.025, -30, 0.012, -0.03}, true);
	raster(directory, "unknown.tif", 0, {120, 0.04, 0, -30, 0, -0.03});
	raster(directory, "unpositioned.tif", 4326, {0, 1, 0, 0, 0, 1}, false, false);
	raster(directory, "singular.tif", 4326, {120, 0.04, 0.08, -30, 0.02, 0.04});
	raster(directory, "polar.tif", 4326, {120, 0.04, 0, 89, 0, -0.03});
	raster(directory, "dateline.tif", 4326, {179.9, 0.1, 0, -30, 0, -0.03});
	raster(directory, "nonfinite.tif", 3857, {std::numeric_limits<double>::infinity(), 1000, 0, -3000000, 0, -1000});
	raster(directory, "missing-grid.tif", 4267, {-100, 0.001, 0, 50, 0, -0.001});
	raster(directory, "northup.tif", 4326, {120, 0.04, 0, -30, 0, -0.03});
	const auto input = directory + "/northup.tif", output = directory + "/northup.ers";
	auto *ds = static_cast<GDALDataset *>(GDALOpen(input.c_str(), GA_ReadOnly));
	// Explicit authority notation is native ERS metadata; it also works in GDAL
	// builds that do not ship the optional ER Mapper name dictionary.
	char projection[] = "PROJ=EPSG:4326", datum[] = "DATUM=EPSG:4326"; char *options[] = {projection, datum, nullptr};
	auto *ers = GetGDALDriverManager()->GetDriverByName("ERS")->CreateCopy(output.c_str(), ds, FALSE, options, nullptr, nullptr);
	if (!ers) throw std::runtime_error("ERS fixture copy failed"); GDALClose(ers); GDALClose(ds);
	// A valid ERS rotation that GDAL 3.6 does not put in GetGeoTransform().
	std::ifstream headerFile(output); std::string header((std::istreambuf_iterator<char>(headerFile)), {});
	const auto rotation = header.find("Rotation\t= 0:0:0.0"); if (rotation == std::string::npos) throw std::runtime_error("ERS rotation declaration missing"); header.replace(rotation, std::string("Rotation\t= 0:0:0.0").size(), "Rotation\t= 10:0:0.0");
	std::ofstream rotatedHeader(directory + "/rotated-ers.ers"); rotatedHeader << header; rotatedHeader.close();
	std::filesystem::copy_file(directory + "/northup", directory + "/rotated-ers", std::filesystem::copy_options::overwrite_existing);
	{
		const auto filename = directory + "/alpha.tif";
		auto *alpha = GetGDALDriverManager()->GetDriverByName("GTiff")->Create(filename.c_str(), 4, 4, 4, GDT_Byte, nullptr); if (!alpha) throw std::runtime_error("alpha fixture failed");
		double gt[] = {13000000, 1000, 700, -3000000, 700, -1000}; check(alpha->SetGeoTransform(gt)); OGRSpatialReference srs; srs.importFromEPSG(3857); check(alpha->SetSpatialRef(&srs));
		for (int b = 1; b <= 4; b++) {
			std::array<unsigned char, 16> values{}; for (int i = 0; i < 16; i++) values[i] = b == 4 ? 255 : 10 + i * 10;
			if (b == 4) { values[5] = 0; values[6] = 96; values[15] = 0; }
			check(alpha->GetRasterBand(b)->SetColorInterpretation(static_cast<GDALColorInterp>(GCI_RedBand + b - 1))); check(alpha->GetRasterBand(b)->RasterIO(GF_Write, 0, 0, 4, 4, values.data(), 4, 4, GDT_Byte, 0, 0));
		}
		GDALClose(alpha);
	}
	std::cout << "Genuine raster-map fixtures: rotated/sheared GTiff, internal mask, nodata, ERS, invalid frames, missing grid\n";
}
