#include <gdal_priv.h>
#include <ogrsf_frmts.h>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>

// Build/test-only: genuine GeoPackage CRS declarations. These files never
// become installed worker dependencies.
static void point(const std::string &directory, const std::string &name, OGRSpatialReference &srs, double x, double y) {
	const auto filename = directory + "/" + name + ".gpkg";
	auto *ds = GetGDALDriverManager()->GetDriverByName("GPKG")->Create(filename.c_str(), 0, 0, 0, GDT_Unknown, nullptr);
	if (!ds) throw std::runtime_error("fixture GeoPackage failed");
	srs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
	auto *layer = ds->CreateLayer("reference", &srs, wkbPoint, nullptr);
	if (!layer) throw std::runtime_error("fixture layer failed");
	auto *feature = OGRFeature::CreateFeature(layer->GetLayerDefn()); OGRPoint geometry(x, y); feature->SetGeometry(&geometry);
	if (layer->CreateFeature(feature) != OGRERR_NONE) throw std::runtime_error("fixture point failed");
	OGRFeature::DestroyFeature(feature); GDALClose(ds);
}
int main(int argc, char **argv) {
	if (argc != 2) return 2;
	GDALAllRegister(); CPLSetConfigOption("PROJ_NETWORK", "OFF"); std::filesystem::create_directories(argv[1]);
	const std::string directory = argv[1];
	// Off-central-meridian reference points, computed independently with the
	// sixth-order Krueger n-series on GRS80 (a=6378137, 1/f=298.257222101,
	// k0=0.9996, false easting=500000, southern false northing=10000000).
	// Geographic references are (116,-32) and (147.25,-35.25), in each named
	// datum separately; they are not claimed to be the same physical point.
	for (int epsg : {28350, 7850, 28355, 7855, 4283, 7844}) {
		OGRSpatialReference srs; if (srs.importFromEPSG(epsg) != OGRERR_NONE) throw std::runtime_error("fixture EPSG failed");
		const bool zone50 = epsg == 28350 || epsg == 7850, projected = epsg != 4283 && epsg != 7844;
		double x = projected ? (zone50 ? 405542.53659728984 : 522743.33553664864) : 116;
		double y = projected ? (zone50 ? 6459127.468715401 : 6099203.676349473) : -32;
		point(directory, "epsg-" + std::to_string(epsg), srs, x, y);
		point(directory, "epsg-" + std::to_string(epsg) + "-yx", srs, y, x);
	}
	OGRSpatialReference nad27; if (nad27.importFromEPSG(4267) != OGRERR_NONE) throw std::runtime_error("fixture NAD27 failed");
	point(directory, "nad27-missing-official-grid", nad27, -100, 50);
	std::cout << "Genuine projection fixtures: MGA94/MGA2020 zones 50/55, geographic GDA94/GDA2020, YX, NAD27 missing grid\n";
}
