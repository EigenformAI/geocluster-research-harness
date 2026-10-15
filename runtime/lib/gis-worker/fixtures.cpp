#include <gdal_priv.h>
#include <ogrsf_frmts.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>

// Acceptance-only fixture producer. Never installed as a reader dependency.
int main(int argc, char **argv) {
	if (argc != 2) return 2;
	GDALAllRegister();
	std::filesystem::create_directories(argv[1]);
	for (const auto &format : {std::pair{"GeoJSON", "points.geojson"}, {"ESRI Shapefile", "points.shp"}, {"MapInfo File", "points.tab"}, {"MapInfo File", "points.mif"}, {"GPKG", "points.gpkg"}}) {
		std::string name = std::string(argv[1]) + "/" + format.second;
		auto *ds = GetGDALDriverManager()->GetDriverByName(format.first)->Create(name.c_str(), 0, 0, 0, GDT_Unknown, nullptr);
		if (!ds) throw std::runtime_error("fixture create failed");
		OGRSpatialReference srs; srs.importFromEPSG(3857); srs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
		auto *layer = ds->CreateLayer("points", &srs, wkbPoint, nullptr);
		OGRFieldDefn label("label", OFTString); label.SetWidth(24); layer->CreateField(&label);
		OGRFieldDefn value("value", OFTInteger); layer->CreateField(&value);
		for (int i = 0; i < 3; i++) {
			auto *f = OGRFeature::CreateFeature(layer->GetLayerDefn());
			f->SetField("label", i == 0 ? "first" : i == 1 ? "second" : "third"); f->SetField("value", i + 7);
			OGRPoint p(1113194.9079327357 + i, 1118889.9748579594); f->SetGeometry(&p);
			if (layer->CreateFeature(f) != OGRERR_NONE) throw std::runtime_error("fixture feature failed");
			OGRFeature::DestroyFeature(f);
		}
		GDALClose(ds);
	}
	{
		std::string name = std::string(argv[1]) + "/dimensions.gpkg";
		auto *ds = GetGDALDriverManager()->GetDriverByName("GPKG")->Create(name.c_str(), 0, 0, 0, GDT_Unknown, nullptr); if (!ds) return 6;
		OGRSpatialReference srs; srs.importFromEPSG(4326); srs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
		auto *layer = ds->CreateLayer("dimensions", &srs, wkbPointZM, nullptr);
		OGRPoint empty, measured(10, 30, 7, 9); empty.set3D(TRUE); empty.setMeasured(TRUE);
		for (auto *geometry : {&empty, &measured, static_cast<OGRPoint *>(nullptr)}) {
			auto *f = OGRFeature::CreateFeature(layer->GetLayerDefn()); f->SetGeometry(geometry); if (layer->CreateFeature(f) != OGRERR_NONE) return 7; OGRFeature::DestroyFeature(f);
		}
		GDALClose(ds);
	}
	for (bool line : {false, true}) {
		std::string name = std::string(argv[1]) + (line ? "/positions.geojson" : "/many.geojson");
		auto *ds = GetGDALDriverManager()->GetDriverByName("GeoJSON")->Create(name.c_str(), 0, 0, 0, GDT_Unknown, nullptr); if (!ds) return 8;
		OGRSpatialReference srs; srs.importFromEPSG(4326); srs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
		auto *layer = ds->CreateLayer("bounded", &srs, line ? wkbLineString : wkbPoint, nullptr);
		OGRFieldDefn value("value", OFTInteger); layer->CreateField(&value);
		for (int i = 0; i < (line ? 1 : 1020); i++) {
			auto *f = OGRFeature::CreateFeature(layer->GetLayerDefn()); f->SetField("value", i);
			OGRPoint p(10, 30); OGRLineString points; if (line) for (int n = 0; n < 20001; n++) points.addPoint(10, 30 + n / 1000000.0);
			f->SetGeometry(line ? static_cast<OGRGeometry *>(&points) : static_cast<OGRGeometry *>(&p)); if (layer->CreateFeature(f) != OGRERR_NONE) return 9; OGRFeature::DestroyFeature(f);
		}
		GDALClose(ds);
	}
	{
		std::string name = std::string(argv[1]) + "/json-range.gpkg";
		auto *ds = GetGDALDriverManager()->GetDriverByName("GPKG")->Create(name.c_str(), 0, 0, 0, GDT_Unknown, nullptr); if (!ds) return 12;
		OGRSpatialReference srs; srs.importFromEPSG(4326); srs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
		auto *layer = ds->CreateLayer("json", &srs, wkbPoint, nullptr); OGRFieldDefn field("object", OFTString); field.SetSubType(OFSTJSON); layer->CreateField(&field);
		auto *f = OGRFeature::CreateFeature(layer->GetLayerDefn()); f->SetField("object", "{\"large\":18446744073709551616}"); OGRPoint p(10, 30); f->SetGeometry(&p); if (layer->CreateFeature(f) != OGRERR_NONE) return 13; OGRFeature::DestroyFeature(f); GDALClose(ds);
	}
	{
		// Valid coordinate-dense GeoJSON stays below the aggregate input ceiling.
		// Small streamed features avoid requiring one enormous decoded geometry.
		std::ofstream out(std::string(argv[1]) + "/dense.geojson", std::ios::binary);
		out << "{\"type\":\"FeatureCollection\",\"features\":[";
		for (int f = 0; f < 500; f++) {
			if (f) out << ',';
			out << "{\"type\":\"Feature\",\"properties\":{\"value\":" << f << "},\"geometry\":{\"type\":\"LineString\",\"coordinates\":[";
			for (int p = 0; p < 10000; p++) { if (p) out << ','; out << (p % 2 ? "[11,31]" : "[10,30]"); }
			out << "]}}";
		}
		out << "]}"; if (!out) return 14;
	}
	CPLSetConfigOption("GDAL_TIFF_INTERNAL_MASK", "YES");
	std::string tiff = std::string(argv[1]) + "/pixels.tif";
	auto *ds = GetGDALDriverManager()->GetDriverByName("GTiff")->Create(tiff.c_str(), 4, 2, 2, GDT_UInt16, nullptr);
	unsigned short data[] = {0, 10, 20, 30, 40, 50, 60, 65535};
	for (int b = 1; b <= 2; b++) {
		auto *band = ds->GetRasterBand(b); band->SetNoDataValue(65535); band->SetScale(2); band->SetOffset(100); band->SetUnitType("m");
		if (band->RasterIO(GF_Write, 0, 0, 4, 2, data, 4, 2, GDT_UInt16, 0, 0) != CE_None) return 3;
	}
	ds->GetRasterBand(1)->CreateMaskBand(GMF_PER_DATASET);
	unsigned char mask[] = {255, 0, 255, 255, 255, 255, 255, 255};
	if (ds->GetRasterBand(1)->GetMaskBand()->RasterIO(GF_Write, 0, 0, 4, 2, mask, 4, 2, GDT_Byte, 0, 0) != CE_None) return 3;
	double transform[] = {10, 1, 0, 20, 0, -1}; ds->SetGeoTransform(transform);
	OGRSpatialReference srs; srs.importFromEPSG(4326); ds->SetSpatialRef(&srs);
	GDALClose(ds);
	ds = static_cast<GDALDataset *>(GDALOpen(tiff.c_str(), GA_ReadOnly));
	std::string ers = std::string(argv[1]) + "/pixels.ers";
	auto *copy = GetGDALDriverManager()->GetDriverByName("ERS")->CreateCopy(ers.c_str(), ds, FALSE, nullptr, nullptr, nullptr);
	if (!copy) return 4;
	GDALClose(copy); GDALClose(ds);
	// Tiny sparse input whose possible sampled decompression exceeds the work ceiling.
	char tiled[] = "TILED=YES", bx[] = "BLOCKXSIZE=512", by[] = "BLOCKYSIZE=512", sparse[] = "SPARSE_OK=YES", compress[] = "COMPRESS=DEFLATE";
	char *options[] = {tiled, bx, by, sparse, compress, nullptr};
	std::string work = std::string(argv[1]) + "/work.tif";
	ds = GetGDALDriverManager()->GetDriverByName("GTiff")->Create(work.c_str(), 4096, 4096, 1, GDT_Float64, options); if (!ds) return 5; GDALClose(ds);
	std::string palette = std::string(argv[1]) + "/palette.tif";
	ds = GetGDALDriverManager()->GetDriverByName("GTiff")->Create(palette.c_str(), 3, 1, 1, GDT_Byte, nullptr); if (!ds) return 10;
	GDALColorTable colors(GPI_RGB); GDALColorEntry red = {255, 0, 0, 255}, green = {0, 255, 0, 255}, blue = {0, 0, 255, 255}; colors.SetColorEntry(0, &red); colors.SetColorEntry(1, &green); colors.SetColorEntry(2, &blue); ds->GetRasterBand(1)->SetColorTable(&colors);
	unsigned char indices[] = {0, 1, 2}; if (ds->GetRasterBand(1)->RasterIO(GF_Write, 0, 0, 3, 1, indices, 3, 1, GDT_Byte, 0, 0) != CE_None) return 11; GDALClose(ds);
	std::cout << "Genuine fixtures: GeoJSON SHP TAB MIF GPKG GTiff ERS\n";
}
