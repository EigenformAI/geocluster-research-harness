#include "confinement.h"
#include "json.h"
#include <gdal_priv.h>
#include <ogrsf_frmts.h>
#include <cpl_vsi.h>
#include <proj.h>
#include <openssl/evp.h>
#include <algorithm>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <vector>
#include "../gis-launcher/build/probe-fixtures.h"

static constexpr int64_t MIB = 1048576;
static constexpr const char *VECTOR_PARSER = "bounded-gdal-vector-v1";
static constexpr const char *ROOT = "/vsimem/gis/";
struct Failure : std::runtime_error { std::string reason; Failure(std::string r, std::string m) : std::runtime_error(m), reason(std::move(r)) {} };
[[noreturn]] static void reject(const std::string &r, const std::string &m) { throw Failure(r, m); }
static std::string lower(std::string s) { for (auto &c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); return s; }
static bool basename(const std::string &s) { return std::regex_match(s, std::regex("[A-Za-z0-9][A-Za-z0-9_. -]{0,127}")) && s.find("..") == std::string::npos && s.back() != ' '; }
static std::string stem(const std::string &s) { return s.substr(0, s.find_last_of('.')); }
static J strings(std::initializer_list<std::string> list) { J j = J::array(); for (const auto &s : list) j.add(s); return j; }
static J extent(const OGREnvelope &e) { J j = J::array(); j.add(e.MinX); j.add(e.MinY); j.add(e.MaxX); j.add(e.MaxY); return j; }
static J numeric(double n) {
	if (!std::isfinite(n)) return J(std::isnan(n) ? "NaN" : n > 0 ? "Infinity" : "-Infinity");
	if (std::trunc(n) == n && std::abs(n) > 9007199254740991.0) { std::ostringstream text; text << std::fixed << std::setprecision(0) << n; return J(text.str()); } return J(n);
}
static J exact(int64_t n) { return n >= -9007199254740991LL && n <= 9007199254740991LL ? J(n) : J(std::to_string(n)); }
static J json_scalar(const J &value) {
	if (value.is(json_type_int) && (value.integer() < -9007199254740991LL || value.integer() > 9007199254740991LL)) return J(value.dump());
	if (value.is(json_type_double)) return numeric(value.number()); return value;
}
static void validate_json_tokens(std::string_view text) {
	// Check original tokens before either GDAL or json-c can narrow/saturate them.
	// Quoted strings and floating-point tokens retain their native interpretation.
	for (size_t i = 0; i < text.size();) {
		if (text[i] == '"') {
			bool nul = false; i++;
			while (i < text.size()) {
				if (text[i] == '\\') { if (text.substr(i, 6) == "\\u0000") nul = true; i = std::min(text.size(), i+2); continue; }
				if (text[i++] == '"') break;
			}
			size_t next = i; while (next < text.size() && std::isspace(static_cast<unsigned char>(text[next]))) next++;
			if (nul && next < text.size() && text[next] == ':') reject("gis_value_unsupported", "A JSON object key contains a decoded NUL that native parsers cannot retain.");
			continue;
		}
		if (text[i] != '-' && (text[i] < '0' || text[i] > '9')) { i++; continue; }
		bool negative = text[i] == '-'; if (negative) i++; size_t start = i;
		while (i < text.size() && text[i] >= '0' && text[i] <= '9') i++;
		if (i < text.size() && (text[i] == '.' || text[i] == 'e' || text[i] == 'E')) { while (i < text.size() && (std::isdigit(static_cast<unsigned char>(text[i])) || text[i] == '.' || text[i] == 'e' || text[i] == 'E' || text[i] == '+' || text[i] == '-')) i++; continue; }
		while (start + 1 < i && text[start] == '0') start++;
		std::string_view digits = text.substr(start, i-start), maximum = negative ? "9223372036854775808" : "9223372036854775807";
		if (digits.size() > maximum.size() || (digits.size() == maximum.size() && digits > maximum)) reject("gis_number_unsupported", "A JSON integer exceeds native signed-64 precision; encode it as a JSON string to retain its exact spelling.");
	}
}
static J json_attribute(const char *text) { validate_json_tokens(text); return J::parse(text).map_scalars(json_scalar); }
static size_t json_string_end(std::string_view text, size_t position) {
	for (size_t i = position+1; i < text.size(); i++) {
		if (text[i] == '\\') { i++; continue; }
		if (text[i] == '"') return i+1;
	}
	reject("gis_decode_failed", "Native feature JSON has an incomplete string.");
}
static size_t json_value_end(std::string_view text, size_t position) {
	if (text[position] == '"') return json_string_end(text, position);
	if (text[position] == '{' || text[position] == '[') {
		int depth = 0; char opened[128];
		for (size_t i = position; i < text.size(); i++) {
			if (text[i] == '"') { i = json_string_end(text, i)-1; continue; }
			if (text[i] == '{' || text[i] == '[') { if (depth == 128) reject("gis_metadata_limit", "JSON structural nesting exceeds its ceiling."); opened[depth++] = text[i]; }
			else if (text[i] == '}' || text[i] == ']') { if (!depth || opened[depth-1] != (text[i] == '}' ? '{' : '[')) reject("gis_decode_failed", "JSON brackets do not match."); if (--depth == 0) return i+1; }
		}
		reject("gis_decode_failed", "Native feature JSON has an incomplete value.");
	}
	size_t end = position; while (end < text.size() && text[end] != ',' && text[end] != '}' && !std::isspace(static_cast<unsigned char>(text[end]))) end++; return end;
}
static std::optional<std::string_view> json_member(std::string_view text, std::string_view member) {
	// Inspect only keys and the selected bounded value. Skip every other tree.
	size_t i = 0;
	auto space = [&] { while (i < text.size() && std::isspace(static_cast<unsigned char>(text[i]))) i++; };
	space(); if (i == text.size() || text[i++] != '{') reject("gis_decode_failed", "Native feature JSON is not an object.");
	for (;;) {
		space(); if (i == text.size() || text[i] == '}') return std::nullopt;
		if (text[i] != '"') reject("gis_decode_failed", "Native feature JSON has an invalid key.");
		size_t start = i; i = json_string_end(text, i); if (i-start > 4096) reject("gis_metadata_limit", "JSON root key exceeds its ceiling."); bool selected = J::parse(std::string(text.substr(start, i-start))).str() == member;
		space(); if (i == text.size() || text[i++] != ':') reject("gis_decode_failed", "Native feature JSON is missing a value.");
		space(); if (i == text.size()) reject("gis_decode_failed", "Native feature JSON ended before a value."); start = i; i = json_value_end(text, i);
		if (selected) return text.substr(start, i-start);
		space(); if (i == text.size() || text[i] == '}') return std::nullopt; if (text[i++] != ',') reject("gis_decode_failed", "Native feature JSON has an invalid separator.");
	}
}
static std::optional<std::string_view> native_properties_json(OGRFeature *feature) {
	const char *data = feature->GetNativeData(), *media = feature->GetNativeMediaType();
	if (!data || !media || (std::strcmp(media, "application/vnd.geo+json") && std::strcmp(media, "application/geo+json"))) return std::nullopt;
	// Original property tokens precede promotion. Geometry is skipped, not parsed.
	return json_member(data, "properties");
}
struct Limits {
	int64_t inputBytes = 40 * MIB, members = 32, features = 1000, positions = 20000, pageSize = 50, pageMaxSize = 200, bands = 32, previewEdge = 512, responseBytes = 16 * MIB, sourcePixels = 100000000, decodedBlockBytes = 128 * MIB;
	int64_t assayRows = 10000, assayPoints = 10000, assayColumns = 128, assayCellBytes = 4096, assayManifestBytes = 16 * MIB, assayResponseBytes = 16 * MIB;
	explicit Limits(const J &j = J()) {
		for (auto pair : {std::pair{"inputBytes", &inputBytes}, {"members", &members}, {"features", &features}, {"positions", &positions}, {"pageMaxSize", &pageMaxSize}, {"bands", &bands}, {"previewEdge", &previewEdge}, {"responseBytes", &responseBytes}, {"sourcePixels", &sourcePixels}, {"decodedBlockBytes", &decodedBlockBytes}}) {
			J v = j.get(pair.first); if (v.null()) continue;
			if (!v.is(json_type_int) || v.integer() < 1 || v.integer() > *pair.second) reject("gis_invalid_options", "Limit exceeds the native physical ceiling."); *pair.second = v.integer();
		}
		J v = j.get("pageSize"); if (!v.null()) { if (!v.is(json_type_int) || v.integer() < 1 || v.integer() > pageMaxSize) reject("gis_invalid_options", "Invalid attribute page size."); pageSize = v.integer(); } pageSize = std::min(pageSize, pageMaxSize);
		for (auto pair : {std::pair{"assayRows", &assayRows}, {"assayPoints", &assayPoints}, {"assayColumns", &assayColumns}, {"assayCellBytes", &assayCellBytes}, {"assayManifestBytes", &assayManifestBytes}, {"assayResponseBytes", &assayResponseBytes}}) {
			J value = j.get(pair.first); if (value.null()) continue; if (!value.is(json_type_int) || value.integer() < 1 || value.integer() > *pair.second) reject("gis_invalid_options", "Assay limit exceeds the native physical ceiling."); *pair.second = value.integer();
		}
	}
};
using Bytes = std::vector<unsigned char>;
using Members = std::map<std::string, Bytes>;
using Dataset = std::unique_ptr<GDALDataset, decltype(&GDALClose)>;
using Feature = std::unique_ptr<OGRFeature, decltype(&OGRFeature::DestroyFeature)>;
using Geometry = std::unique_ptr<OGRGeometry>;
static std::string fingerprint;
static J projectionInventory = J::object();
static std::string file_hash(const char *path);
static J build_info() {
	struct rlimit data, address, cpu; if (getrlimit(RLIMIT_DATA, &data) || getrlimit(RLIMIT_AS, &address) || getrlimit(RLIMIT_CPU, &cpu) || data.rlim_cur != 512 * MIB || address.rlim_cur != 1536 * MIB || cpu.rlim_cur != 30) reject("worker_unavailable", "Installed resource envelope is not enforced.");
	J b = J::object(); b.set("gdal", GDALVersionInfo("RELEASE_NAME")); b.set("proj", proj_info().version); b.set("worker", "fixed-native-gis-v1"); b.set("executableSha256", file_hash("/opt/geocluster-runtime/gis-worker")); b.set("environmentFingerprint", fingerprint); b.set("projectionInventory", projectionInventory); b.set("dataMemoryBytes", static_cast<int64_t>(data.rlim_cur)); b.set("addressSpaceBytes", static_cast<int64_t>(address.rlim_cur)); b.set("cpuSeconds", static_cast<int64_t>(cpu.rlim_cur)); b.set("elapsedMs", 30000); return b;
}
struct Hash {
	std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> ctx{EVP_MD_CTX_new(), EVP_MD_CTX_free};
	Hash() { if (!ctx || EVP_DigestInit_ex(ctx.get(), EVP_sha256(), nullptr) != 1) reject("worker_unavailable", "Installed projection digest could not be initialized."); }
	void update(const void *bytes, size_t size) { if (EVP_DigestUpdate(ctx.get(), bytes, size) != 1) reject("worker_unavailable", "Installed projection digest could not be computed."); }
	void update(const std::string &text) { update(text.data(), text.size()); }
	std::string finish() {
		unsigned char hash[32]; unsigned int size = 0; if (EVP_DigestFinal_ex(ctx.get(), hash, &size) != 1 || size != sizeof(hash)) reject("worker_unavailable", "Installed projection digest could not be completed.");
		std::ostringstream out; for (auto byte : hash) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte); return out.str();
	}
};
struct FileDescriptor {
	int fd; explicit FileDescriptor(int value) : fd(value) {} ~FileDescriptor() { if (fd >= 0) close(fd); }
	FileDescriptor(const FileDescriptor &) = delete; FileDescriptor &operator=(const FileDescriptor &) = delete;
};
static std::string descriptor_hash(int fd, const struct stat &before) {
	Hash hash; char buffer[65536]; int64_t bytes = 0;
	for (;;) {
		ssize_t size = read(fd, buffer, sizeof(buffer)); if (size < 0 && errno == EINTR) continue;
		if (size < 0) reject("worker_unavailable", "An installed projection/build file could not be read completely."); if (!size) break;
		bytes += size; if (bytes > before.st_size) reject("worker_unavailable", "An installed projection/build file changed during fingerprinting."); hash.update(buffer, size);
	}
	struct stat after;
	if (fstat(fd, &after) || bytes != before.st_size || after.st_size != before.st_size || after.st_mtim.tv_sec != before.st_mtim.tv_sec || after.st_mtim.tv_nsec != before.st_mtim.tv_nsec || after.st_ctim.tv_sec != before.st_ctim.tv_sec || after.st_ctim.tv_nsec != before.st_ctim.tv_nsec) reject("worker_unavailable", "An installed projection/build file changed during fingerprinting.");
	return hash.finish();
}
static std::string file_hash(const char *path) {
	FileDescriptor file(open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)); struct stat st;
	if (file.fd < 0 || fstat(file.fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 0) reject("worker_unavailable", "A fixed build/data file cannot be read.");
	return descriptor_hash(file.fd, st);
}
struct ProjectionFiles {
	struct Record { int64_t bytes; std::string sha256; };
	std::map<std::string, Record> files; int64_t entries = 0, totalBytes = 0;
	// Fixed installed-data ceilings bound traversal, descriptors and hash work.
	// Hash contents in chunks; never retain grid bytes in the worker heap.
	static constexpr int64_t MAX_ENTRIES = 16384, MAX_BYTES = 4096 * MIB;
	void walk(int fd, const std::string &relative, int depth = 0) {
		DIR *opened = fdopendir(fd); if (!opened) { close(fd); reject("worker_unavailable", "Installed projection data directory cannot be listed."); }
		auto closeDirectory = [](DIR *dir) { closedir(dir); }; std::unique_ptr<DIR, decltype(closeDirectory)> directory(opened, closeDirectory);
		for (;;) {
			errno = 0; auto *entry = readdir(directory.get());
			if (!entry) { if (errno) reject("worker_unavailable", "Installed projection data inventory is incomplete."); break; }
			std::string name = entry->d_name; if (name == "." || name == "..") continue;
			if (++entries > MAX_ENTRIES || relative.size() + name.size() > 4096) reject("worker_unavailable", "Installed projection data inventory exceeds its traversal ceiling.");
			struct stat listed; if (fstatat(dirfd(directory.get()), name.c_str(), &listed, AT_SYMLINK_NOFOLLOW)) reject("worker_unavailable", "Installed projection data inventory cannot be inspected.");
			if (S_ISDIR(listed.st_mode)) {
				if (depth >= 16) reject("worker_unavailable", "Installed projection data inventory exceeds its directory depth ceiling.");
				int child = openat(dirfd(directory.get()), name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
				if (child < 0) reject("worker_unavailable", "Installed projection data subdirectory cannot be listed."); walk(child, relative + name + "/", depth+1);
			} else if (S_ISREG(listed.st_mode)) {
				FileDescriptor file(openat(dirfd(directory.get()), name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
				// Only readable regular files belong to this confined inventory.
				// Symlinks and special files are never opened or followed.
				if (file.fd < 0 && (errno == EACCES || errno == EPERM)) continue;
				struct stat st; if (file.fd < 0 || fstat(file.fd, &st) || !S_ISREG(st.st_mode) || st.st_dev != listed.st_dev || st.st_ino != listed.st_ino || st.st_size < 0) reject("worker_unavailable", "Installed projection data inventory changed or cannot be read.");
				if (st.st_size > MAX_BYTES - totalBytes) reject("worker_unavailable", "Installed projection data inventory exceeds its byte ceiling."); totalBytes += st.st_size;
				files.emplace(relative + name, Record{st.st_size, descriptor_hash(file.fd, st)});
			}
		}
	}
};
static std::string environment_hash() {
	int root = open("/usr/share/proj", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); if (root < 0) reject("worker_unavailable", "Installed projection data root cannot be read.");
	ProjectionFiles inventory; inventory.walk(root, ""); auto database = inventory.files.find("proj.db"); if (database == inventory.files.end()) reject("worker_unavailable", "Installed projection database cannot be read.");
	// Inventory every readable regular file, not an extension allowlist or the
	// grid lock: PROJ also accepts extensionless data and legacy grid formats.
	// Length-prefixed paths plus sizes and fixed-size file digests avoid ambiguous
	// records. std::map supplies stable bytewise relative-path order.
	Hash hash; hash.update("proj-inventory-v1\n"); J selected = J::array();
	for (const auto &[name, record] : inventory.files) {
		hash.update(std::to_string(name.size()) + ":" + name + ":" + std::to_string(record.bytes) + ":" + record.sha256 + "\n");
		if (name == "au_icsm_GDA94_GDA2020_conformal.tif" || name == "au_icsm_GDA94_GDA2020_conformal_and_distortion.tif") { J grid = J::object(); grid.set("name", name); grid.set("byteLength", record.bytes); grid.set("sha256", record.sha256); selected.add(grid); }
	}
	std::string digest = hash.finish(); projectionInventory.set("root", "/usr/share/proj"); projectionInventory.set("algorithm", "sha256-path-content-v1"); projectionInventory.set("sha256", digest); projectionInventory.set("fileCount", static_cast<int64_t>(inventory.files.size())); projectionInventory.set("totalBytes", inventory.totalBytes); projectionInventory.set("selectedGrids", selected);
	std::string result = "gdal=" + std::string(GDALVersionInfo("RELEASE_NAME")) + ";proj=" + proj_info().version + ";proj-db=" + database->second.sha256 + ";grids=" + digest;
	if (result.size() > 256) reject("worker_unavailable", "Installed projection fingerprint exceeds the display option ceiling."); return result;
}
static void response_bound(const J &j, const Limits &limits, const std::string &reason) { if (static_cast<int64_t>(j.dump().size()) > limits.responseBytes) reject(reason, "Native JSON exceeds the configured response ceiling."); }
static uint32_t be32(const Bytes &b, size_t i) { return (uint32_t(b.at(i)) << 24) | (uint32_t(b.at(i+1)) << 16) | (uint32_t(b.at(i+2)) << 8) | b.at(i+3); }
static uint32_t le32(const Bytes &b, size_t i) { return uint32_t(b.at(i)) | (uint32_t(b.at(i+1)) << 8) | (uint32_t(b.at(i+2)) << 16) | (uint32_t(b.at(i+3)) << 24); }
static std::string member_text(const Bytes &b) { if (b.size() > 65536 || std::find(b.begin(), b.end(), 0) != b.end()) reject("gis_bundle_invalid", "Declared companion header is not bounded text."); return std::string(b.begin(), b.end()); }
static void require_member(const Members &m, std::set<std::string> &accepted, const std::string &name) {
	if (!basename(name) || !m.count(lower(name))) reject("gis_bundle_invalid", "A required companion is missing or references an external path."); accepted.insert(lower(name));
}
static int64_t mid_rows(const Bytes &b) {
	bool quoted = false, content = false; int64_t rows = 0;
	for (size_t i = 0; i < b.size(); i++) {
		char c = b[i]; if (c == '"') { if (quoted && i + 1 < b.size() && b[i+1] == '"') i++; else quoted = !quoted; }
		if (c == '\n' && !quoted) { rows++; content = false; } else if (c != '\r') content = true;
	}
	if (quoted) reject("gis_bundle_invalid", "MID has an unterminated quoted field."); return rows + (content ? 1 : 0);
}
static std::string validate_bundle(const Members &m, const std::string &primary, const std::string &kind) {
	const auto &b = m.at(primary); std::string ext = primary.substr(primary.find_last_of('.') + 1), base = stem(primary), driver;
	std::set<std::string> accepted{primary};
	if (ext == "ecw") reject("gis_decoder_unavailable", "ECW decoding is unavailable in the fixed system GDAL build.");
	if (kind == "vector" && (ext == "geojson" || ext == "json")) driver = "GeoJSON";
	else if (kind == "vector" && ext == "shp") {
		driver = "ESRI Shapefile"; require_member(m, accepted, base + ".shx"); require_member(m, accepted, base + ".dbf");
		for (const auto &suffix : {".prj", ".cpg"}) if (m.count(base + suffix)) accepted.insert(base + suffix);
		const auto &shx = m.at(base + ".shx"), &dbf = m.at(base + ".dbf");
		if (b.size() < 100 || shx.size() < 100 || dbf.size() < 32 || be32(b, 0) != 9994 || be32(shx, 0) != 9994 || uint64_t(be32(b, 24)) * 2 != b.size() || uint64_t(be32(shx, 24)) * 2 != shx.size() || (shx.size() - 100) % 8 != 0 || le32(b, 32) != le32(shx, 32)) reject("gis_bundle_invalid", "SHP/SHX headers do not describe the captured bytes.");
		uint64_t count = (shx.size() - 100) / 8, rows = le32(dbf, 4), header = dbf[8] + uint64_t(dbf[9]) * 256, record = dbf[10] + uint64_t(dbf[11]) * 256;
		if (rows != count || header < 32 || !record || header + rows * record > dbf.size()) reject("gis_bundle_invalid", "SHP/SHX/DBF feature rows disagree or are truncated.");
		uint64_t position = 100;
		for (size_t i = 100; i < shx.size(); i += 8) {
			uint64_t offset = uint64_t(be32(shx, i)) * 2, bytes = uint64_t(be32(shx, i+4)) * 2;
			if (offset != position || offset + 8 + bytes > b.size() || be32(b, offset+4) != bytes / 2) reject("gis_bundle_invalid", "SHP records disagree with captured SHX offsets."); position = offset + 8 + bytes;
		}
		if (position != b.size()) reject("gis_bundle_invalid", "SHP has uncaptured or unindexed records.");
	} else if (kind == "vector" && ext == "tab") {
		driver = "MapInfo File"; std::string text = member_text(b); std::smatch match;
		std::smatch fieldsStart; if (std::regex_search(text, fieldsStart, std::regex("(?:^|[\\r\\n])[ \\t]*Fields[ \\t]", std::regex::icase))) text.resize(fieldsStart.position());
		if (!std::regex_search(text, std::regex("Type[ \\t]+NATIVE", std::regex::icase))) reject("gis_bundle_invalid", "Only native vector TAB tables are accepted.");
		std::regex declaration("\\bFile[ \\t]+\"([^\"]+)\"", std::regex::icase);
		if (std::distance(std::sregex_iterator(text.begin(), text.end(), declaration), std::sregex_iterator()) > 1) reject("gis_bundle_invalid", "TAB has ambiguous data member declarations.");
		bool explicitFile = std::regex_search(text, match, declaration);
		if (!explicitFile && std::regex_search(text, std::regex("\\bFile\\b", std::regex::icase))) reject("gis_bundle_invalid", "TAB File must be a quoted captured basename.");
		// Native TAB omits File for its standard same-stem DAT companion.
		std::string data = explicitFile ? lower(match[1]) : base + ".dat"; if (data.size() < 4 || (data.substr(data.size()-4) != ".dat" && data.substr(data.size()-4) != ".dbf")) reject("gis_bundle_invalid", "TAB references an unsupported data member.");
		require_member(m, accepted, data); require_member(m, accepted, base + ".map"); require_member(m, accepted, base + ".id");
		const auto &dat = m.at(data), &ids = m.at(base + ".id"), &map = m.at(base + ".map");
		if (dat.size() < 32 || map.size() < 512 || uint64_t(le32(dat, 4)) * 4 != ids.size()) reject("gis_bundle_invalid", "TAB data and ID feature counts disagree.");
		uint64_t rows = le32(dat, 4), header = dat[8] + uint64_t(dat[9]) * 256, record = dat[10] + uint64_t(dat[11]) * 256;
		if (header < 32 || !record || header + rows * record > dat.size()) reject("gis_bundle_invalid", "TAB data records are truncated.");
		for (size_t i = 0; i < ids.size(); i += 4) { auto offset = le32(ids, i); if (offset && (offset < 512 || offset >= map.size())) reject("gis_bundle_invalid", "TAB ID points outside the captured MAP bytes."); }
	} else if (kind == "vector" && ext == "mif") { driver = "MapInfo File"; require_member(m, accepted, base + ".mid"); }
	else if (kind == "vector" && ext == "gpkg") {
		driver = "GPKG";
		for (const auto &suffix : {"-wal", "-shm", "-journal"}) if (m.count(primary + suffix)) reject("gis_snapshot_required", "GeoPackage journal dependencies require a closed checkpointed snapshot.");
		if (b.size() < 100 || std::memcmp(b.data(), "SQLite format 3\0", 16)) reject("gis_bundle_invalid", "GeoPackage is not a captured SQLite database.");
		if (b[18] == 2 || b[19] == 2) reject("gis_snapshot_required", "GeoPackage requires a closed checkpointed snapshot with no WAL or journal dependencies.");
		if (b[18] != 1 || b[19] != 1 || be32(b, 68) != 0x47504b47) reject("gis_bundle_invalid", "GeoPackage header is not a closed supported snapshot.");
	} else if (kind == "raster" && (ext == "tif" || ext == "tiff")) driver = "GTiff";
	else if (kind == "raster" && ext == "ers") {
		driver = "ERS"; std::string text = member_text(b); std::smatch match;
		std::regex declaration("DataFile[ \\t]*=[ \\t]*\"([^\"]+)\"", std::regex::icase);
		if (std::distance(std::sregex_iterator(text.begin(), text.end(), declaration), std::sregex_iterator()) > 1) reject("gis_bundle_invalid", "ERS has ambiguous data member declarations.");
		if (std::regex_search(text, match, declaration)) require_member(m, accepted, match[1]);
		else {
			if (std::regex_search(text, std::regex("DataFile[ \\t]*=", std::regex::icase))) reject("gis_bundle_invalid", "ERS DataFile must be a quoted captured basename.");
			// ERS defines the data basename by removing .ers when DataFile is absent.
			require_member(m, accepted, base);
		}
		if (std::regex_search(text, std::regex("DataSetType[ \\t]*=[ \\t]*[^\\r\\n]*Translated", std::regex::icase))) reject("gis_bundle_invalid", "External translated ERS datasets are unavailable.");
	} else reject("gis_format_unsupported", "This input family is outside the fixed GIS allowlist.");
	if (accepted.size() != m.size()) reject("gis_bundle_invalid", "The bundle contains undeclared or unsupported companions."); return driver;
}
struct Vsimem {
	std::vector<std::string> paths;
	explicit Vsimem(const Members &m) {
		VSIMkdir(ROOT, 0700);
		for (const auto &[name, bytes] : m) {
			std::string path = std::string(ROOT) + name; auto *data = static_cast<GByte *>(VSI_MALLOC_VERBOSE(std::max<size_t>(bytes.size(), 1))); if (!data) reject("gis_resource_limit", "Member memory ceiling reached.");
			std::memcpy(data, bytes.data(), bytes.size()); auto *file = VSIFileFromMemBuffer(path.c_str(), data, bytes.size(), TRUE); if (!file) { VSIFree(data); reject("gis_resource_limit", "In-memory member could not be created."); } VSIFCloseL(file); paths.push_back(path);
		}
		// Resolve case-folded declared basenames without changing captured header bytes.
		// Aliases share the same retained buffer; they never supply a missing member.
		for (const auto &[name, bytes] : m) {
			if (name.size() < 4 || (name.substr(name.size()-4) != ".ers" && name.substr(name.size()-4) != ".tab")) continue;
			std::string text = member_text(bytes); std::regex declaration("(?:DataFile[ \\t]*=|\\bFile)[ \\t]*\"([^\"]+)\"", std::regex::icase);
			for (std::sregex_iterator it(text.begin(), text.end(), declaration), end; it != end; ++it) {
				std::string reference = (*it)[1]; if (!basename(reference) || !m.count(lower(reference))) reject("gis_bundle_invalid", "A declared companion is external or uncaptured."); if (reference == lower(reference)) continue; std::string alias = std::string(ROOT) + reference; if (std::find(paths.begin(), paths.end(), alias) != paths.end()) continue;
				vsi_l_offset size; auto *buffer = VSIGetMemFileBuffer((std::string(ROOT) + lower(reference)).c_str(), &size, FALSE); if (!buffer) reject("gis_bundle_invalid", "Declared companion was not captured.");
				auto *file = VSIFileFromMemBuffer(alias.c_str(), buffer, size, FALSE); if (!file) reject("gis_resource_limit", "Companion alias allocation failed."); VSIFCloseL(file); paths.push_back(alias);
			}
		}
	}
	~Vsimem() { for (auto it = paths.rbegin(); it != paths.rend(); ++it) VSIUnlink(it->c_str()); VSIRmdir(ROOT); }
};
static Dataset open_dataset(const Members &m, const std::string &primary, const std::string &kind, const std::string &driver) {
	const char *drivers[] = {driver.c_str(), nullptr}; CPLErrorReset();
	// JSON-valued attributes remain JSON instead of inferred, coerced list types.
	const char *jsonOptions[] = {"ARRAY_AS_STRING=YES", "FLATTEN_NESTED_ATTRIBUTES=NO", "NATIVE_DATA=YES", nullptr};
	auto *raw = static_cast<GDALDataset *>(GDALOpenEx((std::string(ROOT) + primary).c_str(), GDAL_OF_READONLY | (kind == "vector" ? GDAL_OF_VECTOR : GDAL_OF_RASTER), drivers, driver == "GeoJSON" ? jsonOptions : nullptr, nullptr));
	if (!raw) reject("gis_decode_failed", "Captured members could not be decoded by the selected system driver.");
	Dataset ds(raw, GDALClose); char **files = ds->GetFileList();
	for (int i = 0; files && files[i]; i++) {
		std::string p = files[i]; if (p.rfind(ROOT, 0) != 0 || !m.count(lower(p.substr(std::strlen(ROOT))))) { CSLDestroy(files); reject("gis_bundle_invalid", "Driver requested an external or uncaptured member."); }
	}
	CSLDestroy(files); return ds;
}
static J fields(OGRLayer *layer) {
	J list = J::array(); auto *def = layer->GetLayerDefn(); if (def->GetFieldCount() > 4096) reject("gis_metadata_limit", "Layer field count exceeds the fixed ceiling.");
	for (int i = 0; i < def->GetFieldCount(); i++) { auto *f = def->GetFieldDefn(i); J j = J::object(); std::string type = OGRFieldDefn::GetFieldTypeName(f->GetType()); if (f->GetSubType() != OFSTNone) type += " (" + std::string(OGRFieldDefn::GetFieldSubTypeName(f->GetSubType())) + ")"; j.set("name", f->GetNameRef()); j.set("type", type); j.set("width", f->GetWidth()); j.set("precision", f->GetPrecision()); list.add(j); } return list;
}
static J properties(OGRFeature *f, const Limits &limits, const char *responseReason) {
	if (auto original = native_properties_json(f)) {
		if (static_cast<int64_t>(original->size()) > limits.responseBytes) reject(responseReason, "Original feature properties exceed the response ceiling.");
		validate_json_tokens(*original); J value = J::parse(std::string(*original));
		if (value.is(json_type_object)) return value.map_scalars(json_scalar);
		if (!value.null()) reject("gis_decode_failed", "GeoJSON properties must be an object or null.");
	}
	J result = J::object(); auto *def = f->GetDefnRef();
	for (int i = 0; i < def->GetFieldCount(); i++) {
		J value;
		if (f->IsFieldSetAndNotNull(i)) {
			switch (def->GetFieldDefn(i)->GetType()) {
				case OFTInteger: value = def->GetFieldDefn(i)->GetSubType() == OFSTBoolean ? J(f->GetFieldAsInteger(i) != 0) : J(f->GetFieldAsInteger(i)); break;
				case OFTInteger64: value = exact(f->GetFieldAsInteger64(i)); break;
				case OFTReal: value = numeric(f->GetFieldAsDouble(i)); break;
				case OFTString: value = def->GetFieldDefn(i)->GetSubType() == OFSTJSON ? json_attribute(f->GetFieldAsString(i)) : J(f->GetFieldAsString(i)); break;
				case OFTStringList: { value = J::array(); char **list = f->GetFieldAsStringList(i); for (int n = 0; list && list[n]; n++) value.add(list[n]); break; }
				case OFTIntegerList: { value = J::array(); int n; const int *list = f->GetFieldAsIntegerList(i, &n); for (int k = 0; k < n; k++) value.add(list[k]); break; }
				case OFTInteger64List: { value = J::array(); int n; const GIntBig *list = f->GetFieldAsInteger64List(i, &n); for (int k = 0; k < n; k++) value.add(exact(list[k])); break; }
				case OFTRealList: { value = J::array(); int n; const double *list = f->GetFieldAsDoubleList(i, &n); for (int k = 0; k < n; k++) value.add(numeric(list[k])); break; }
				default: value = J(f->GetFieldAsString(i));
			}
		}
		result.set(def->GetFieldDefn(i)->GetNameRef(), value);
	}
	return result;
}
static J wkt(OGRSpatialReference *srs) { if (!srs) return J(); char *text = nullptr; srs->exportToWkt(&text); J result(text ? text : ""); CPLFree(text); return result; }
static J axis_mapping(OGRSpatialReference *srs) { if (!srs) return J(); J j = J::array(); for (int value : srs->GetDataAxisToSRSAxisMapping()) j.add(value); return j; }
static J count(OGRLayer *l) { auto n = l->GetFeatureCount(FALSE); return n < 0 || n > 9007199254740991LL ? J() : J(static_cast<int64_t>(n)); }
static OGRLayer *get_layer(GDALDataset *ds, int index) { auto *l = ds->GetLayer(index); if (!l) reject("gis_decode_failed", "Native layer could not be read."); return l; }
static void layer_count(GDALDataset *ds) { if (ds->GetLayerCount() < 1 || ds->GetLayerCount() > 32) reject("gis_metadata_limit", "Dataset must contain one to 32 vector layers."); }
static J vector_manifest(GDALDataset *ds, const Limits &limits, bool unknownCrs) {
	layer_count(ds); J result = J::object(), layers = J::array(); result.set("schemaVersion", 1); result.set("parser", VECTOR_PARSER); result.set("coverage", "Layer metadata; geometry not requested."); result.set("warnings", J::array());
	for (int i = 0; i < ds->GetLayerCount(); i++) {
		auto *l = get_layer(ds, i); J j = J::object(); j.set("id", "layer-" + std::to_string(i)); j.set("name", l->GetName()); j.set("fields", fields(l)); j.set("crsWkt", unknownCrs ? J() : wkt(l->GetSpatialRef())); j.set("axisMapping", unknownCrs ? J() : axis_mapping(l->GetSpatialRef())); j.set("reportedFeatureCount", count(l)); layers.add(j);
	}
	result.set("layers", layers); response_bound(result, limits, "gis_response_limit"); return result;
}
static int64_t option_integer(const J &options, const char *key, int64_t fallback, int64_t min, int64_t max) {
	J v = options.get(key); if (v.null()) return fallback; if (!v.is(json_type_int) || v.integer() < min || v.integer() > max) reject("gis_invalid_options", "Query position, page size, or selected band is out of range."); return v.integer();
}
static Feature next(OGRLayer *l) { CPLErrorReset(); Feature f(l->GetNextFeature(), OGRFeature::DestroyFeature); if (CPLGetLastErrorType() >= CE_Failure) reject("gis_decode_failed", "Source feature decode failed; complete geometry cannot be claimed."); return f; }
static J vector_page(GDALDataset *ds, const J &options, const Limits &limits) {
	layer_count(ds); std::string id = options.get("layerId").str(); if (!std::regex_match(id, std::regex("layer-(0|[1-9][0-9]?)"))) reject("gis_invalid_options", "A valid source layer ID is required for attribute pages.");
	int index = std::stoi(id.substr(6)); if (index >= ds->GetLayerCount()) reject("gis_invalid_options", "Layer ID does not exist."); auto *l = get_layer(ds, index);
	int64_t offset = option_integer(options, "offset", 0, 0, 1000000), limit = option_integer(options, "limit", limits.pageSize, 1, limits.pageMaxSize);
	const char *ignored[] = {"OGR_GEOMETRY", nullptr}; l->SetIgnoredFields(ignored); l->ResetReading(); int64_t scanned = 0; J rows = J::array();
	while (scanned < offset) { auto f = next(l); if (!f) break; scanned++; }
	bool more = false;
	for (int64_t n = 0; n <= limit; n++) {
		auto f = next(l); if (!f) break;
		if (n == limit) { more = true; scanned++; break; }
		J row = J::object(); row.set("locator", id + ":" + std::to_string(scanned)); if (f->GetFID() != OGRNullFID) row.set("sourceId", std::to_string(f->GetFID())); row.set("properties", properties(f.get(), limits, "gis_response_limit")); rows.add(row); scanned++; response_bound(rows, limits, "gis_response_limit");
	}
	J result = J::object(); result.set("schemaVersion", 1); result.set("parser", VECTOR_PARSER); result.set("layerId", id); result.set("offset", offset); result.set("limit", limit); result.set("rows", rows); result.set("nextOffset", more ? J(offset + rows.size()) : J()); result.set("reportedFeatureCount", count(l)); result.set("scannedFeatures", scanned); result.set("geometryCoverage", "not-requested"); result.set("coverage", "Source-position attribute page; geometry not requested."); result.set("warnings", J::array()); response_bound(result, limits, "gis_response_limit"); return result;
}
struct GeometryBudget { int64_t positions = 0, nodes = 0; const Limits &limits; };
static J position(const OGRPoint &p, GeometryBudget &b, bool geographic) {
	if (++b.positions > b.limits.positions) reject("vector_position_limit", "Complete geometry exceeds the position ceiling.");
	if (!std::isfinite(p.getX()) || !std::isfinite(p.getY()) || (p.Is3D() && !std::isfinite(p.getZ())) || (p.IsMeasured() && !std::isfinite(p.getM()))) reject("gis_geometry_invalid", "A native geometry coordinate is nonfinite.");
	if (geographic && (p.getX() < -180 || p.getX() > 180 || p.getY() < -90 || p.getY() > 90)) reject("gis_display_domain", "Transformed coordinates are outside the CRS84 geographic domain.");
	J j = J::array(); j.add(p.getX()); j.add(p.getY()); if (p.Is3D()) j.add(p.getZ()); if (p.IsMeasured()) j.add(p.getM()); return j;
}
static J line_coordinates(const OGRLineString *line, GeometryBudget &b, bool geographic) { J a = J::array(); for (int i = 0; i < line->getNumPoints(); i++) { OGRPoint p; line->getPoint(i, &p); a.add(position(p, b, geographic)); } return a; }
static J polygon_coordinates(const OGRPolygon *p, GeometryBudget &b, bool geographic) { J a = J::array(); if (p->getExteriorRing()) a.add(line_coordinates(p->getExteriorRing(), b, geographic)); for (int i = 0; i < p->getNumInteriorRings(); i++) a.add(line_coordinates(p->getInteriorRing(i), b, geographic)); return a; }
static J geometry_json(const OGRGeometry *g, GeometryBudget &b, bool geographic = false, int depth = 0) {
	if (!g) return J(); if (depth > 24 || ++b.nodes > 100000) reject("gis_geometry_limit", "Geometry nesting exceeds the fixed ceiling.");
	J j = J::object(), coordinates; std::string type;
	switch (wkbFlatten(g->getGeometryType())) {
		case wkbPoint: type = "Point"; coordinates = g->IsEmpty() ? J::array() : position(*g->toPoint(), b, geographic); break;
		case wkbLineString: type = "LineString"; coordinates = line_coordinates(g->toLineString(), b, geographic); break;
		case wkbPolygon: type = "Polygon"; coordinates = polygon_coordinates(g->toPolygon(), b, geographic); break;
		case wkbMultiPoint: case wkbMultiLineString: case wkbMultiPolygon: case wkbGeometryCollection: {
			bool collection = wkbFlatten(g->getGeometryType()) == wkbGeometryCollection;
			type = collection ? "GeometryCollection" : wkbFlatten(g->getGeometryType()) == wkbMultiPoint ? "MultiPoint" : wkbFlatten(g->getGeometryType()) == wkbMultiLineString ? "MultiLineString" : "MultiPolygon";
			coordinates = J::array(); auto *c = g->toGeometryCollection();
			for (int i = 0; i < c->getNumGeometries(); i++) { J child = geometry_json(c->getGeometryRef(i), b, geographic, depth+1); if (child.null() && !collection) reject("gis_geometry_unsupported", "Empty members of a native multi-geometry cannot be represented without alteration."); coordinates.add(collection ? child : child.get("coordinates")); }
			break;
		}
		default: reject("gis_geometry_unsupported", "Native curved or surface geometry cannot be represented without alteration.");
	}
	j.set("type", type); j.set(type == "GeometryCollection" ? "geometries" : "coordinates", coordinates); return j;
}
static bool contains_area(double west, double south, double east, double north, const OGREnvelope &area) {
	return area.MinY >= south && area.MaxY <= north && (west <= east ? area.MinX >= west && area.MaxX <= east : area.MinX >= west || area.MaxX <= east);
}
static bool object_area(PJ_CONTEXT *ctx, const PJ *object, const OGREnvelope &area, bool &known) {
	double west, south, east, north; const char *name = nullptr; known = proj_get_area_of_use(ctx, object, &west, &south, &east, &north, &name);
	return known && contains_area(west, south, east, north, area);
}
static bool conversions_only(PJ_CONTEXT *ctx, const PJ *operation, int depth = 0) {
	if (depth > 16) return false; auto type = proj_get_type(operation); if (type == PJ_TYPE_CONVERSION) return true;
	if (type != PJ_TYPE_CONCATENATED_OPERATION) return false;
	int n = proj_concatoperation_get_step_count(ctx, operation); if (n < 1 || n > 32) return false;
	for (int i = 0; i < n; i++) { auto *step = proj_concatoperation_get_step(ctx, operation, i); bool conversion = step && conversions_only(ctx, step, depth+1); proj_destroy(step); if (!conversion) return false; } return true;
}
static PJ *source_object(PJ_CONTEXT *ctx, OGRSpatialReference *srs) {
	PJ *source = proj_create(ctx, wkt(srs).str().c_str()); if (!source) return nullptr;
	// WKT1 may omit usage metadata. Use database usage only after proving CRS equivalence.
	const char *authority = srs->GetAuthorityName(nullptr), *code = srs->GetAuthorityCode(nullptr);
	PJ *canonical = authority && code ? proj_create_from_database(ctx, authority, code, PJ_CATEGORY_CRS, false, nullptr) : nullptr;
	if (canonical && proj_is_equivalent_to_with_ctx(ctx, source, canonical, PJ_COMP_EQUIVALENT_EXCEPT_AXIS_ORDER_GEOGCRS)) { proj_destroy(source); return canonical; }
	proj_destroy(canonical); return source;
}
struct Placement {
	std::unique_ptr<OGRSpatialReference> source;
	OGRSpatialReference target;
	std::unique_ptr<OGRCoordinateTransformation, decltype(&OCTDestroyCoordinateTransformation)> transform{nullptr, OCTDestroyCoordinateTransformation};
	J json = J::object(), display = J::object(), reasons = J::array();
	OGREnvelope bounds; bool hasBounds = false, allow = false; int displayed = 0, drawable = 0, empty = 0;
	Placement(OGRLayer *l, const std::string &id, const J &options, bool formatConvention, bool unknownCrs) {
		std::string basis = l->GetSpatialRef() && !unknownCrs ? (formatConvention ? "format-convention" : "declared") : "unknown";
		if (l->GetSpatialRef() && !unknownCrs) source.reset(l->GetSpatialRef()->Clone());
		J assumption = options.get("sourceCrs");
		if (!assumption.null()) {
			if (!assumption.is(json_type_object) || !std::regex_match(assumption.get("layerId").str(), std::regex("layer-(0|[1-9][0-9]?)")) || !std::regex_match(assumption.get("code").str(), std::regex("EPSG:[1-9][0-9]{0,6}|OGC:CRS84")) || (assumption.get("axisOrder").str() != "xy" && assumption.get("axisOrder").str() != "yx")) reject("gis_invalid_options", "Source CRS assumptions require an authority code, layer ID, and explicit XY or YX order.");
			if (assumption.get("layerId").str() == id) {
				source = std::make_unique<OGRSpatialReference>(); if (source->SetFromUserInput(assumption.get("code").str().c_str()) != OGRERR_NONE) reject("gis_invalid_options", "Assumed source CRS is not installed."); source->SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER); if (source->GetDataAxisToSRSAxisMapping().size() < 2) reject("gis_invalid_options", "Assumed source CRS needs at least two coordinate axes.");
				if (assumption.get("axisOrder").str() == "yx") { auto mapping = source->GetDataAxisToSRSAxisMapping(); std::swap(mapping[0], mapping[1]); source->SetDataAxisToSRSAxisMapping(mapping); } basis = "user-assumed";
			}
		}
		J frame = J::object(); frame.set("basis", basis); frame.set("wkt", wkt(source.get())); frame.set("dataAxisMapping", axis_mapping(source.get()));
		const char *units = nullptr; if (source) { if (source->IsGeographic()) source->GetAngularUnits(&units); else source->GetLinearUnits(&units); } frame.set("units", units ? J(units) : J());
		json.set("sourceFrame", frame); json.set("environmentFingerprint", fingerprint); json.set("displayCrs", "OGC:CRS84");
		J approximate = options.get("allowApproximate"); if (!approximate.null() && !approximate.is(json_type_boolean)) reject("gis_invalid_options", "allowApproximate must be boolean."); allow = approximate.boolean(); json.set("operation", J());
		if (!source) { reasons.add("Source CRS is unknown. Supply a source CRS assumption for geographic placement."); json.set("operation", J()); return; }
		target.SetFromUserInput("OGC:CRS84"); target.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
	}
	void prepare(const std::vector<std::pair<std::string, Geometry>> &geometries) {
		if (!source) return;
		// Derive source-geographic bounds by inverse projection/axis conversion only.
		// No datum transformation is selected or applied to establish this AOI.
		std::unique_ptr<OGRSpatialReference> geographic(source->CloneGeogCS());
		if (!geographic) { reasons.add("Source geographic area cannot be established for operation selection."); return; }
		geographic->SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER); OGRCoordinateTransformationOptions settings; settings.SetBallparkAllowed(false);
		std::unique_ptr<OGRCoordinateTransformation, decltype(&OCTDestroyCoordinateTransformation)> inverse(OGRCreateCoordinateTransformation(source.get(), geographic.get(), settings), OCTDestroyCoordinateTransformation);
		if (!inverse) { reasons.add("Source geographic area cannot be established without an unrelated datum operation."); return; }
		OGREnvelope area; bool hasArea = false; double unitDegrees = geographic->GetAngularUnits() * 180.0 / std::acos(-1.0), meridian = geographic->GetPrimeMeridian();
		for (const auto &[locator, native] : geometries) {
			(void)locator; if (!native || native->IsEmpty()) continue; Geometry g(native->clone());
			if (g->transform(inverse.get()) != OGRERR_NONE) { reasons.add("Source geographic area could not be determined for every nonempty feature."); return; }
			OGREnvelope e; g->getEnvelope(&e); e.MinX = e.MinX * unitDegrees + meridian; e.MaxX = e.MaxX * unitDegrees + meridian; e.MinY *= unitDegrees; e.MaxY *= unitDegrees;
			if (!std::isfinite(e.MinX) || !std::isfinite(e.MaxX) || !std::isfinite(e.MinY) || !std::isfinite(e.MaxY) || e.MinX < -180 || e.MaxX > 180 || e.MinY < -90 || e.MaxY > 90) { reasons.add("Source geographic area is outside the finite longitude/latitude domain."); return; }
			if (!hasArea) { area = e; hasArea = true; } else area.Merge(e);
		}
		if (!hasArea) { reasons.add("No nonempty geometry establishes an area for geographic operation selection."); return; }
		// Source-geographic bounds precede any datum shift. A conservative margin
		// avoids selecting a regional operation at an uncertain geographic boundary.
		area.MinX = std::max(-180.0, area.MinX - 0.01); area.MaxX = std::min(180.0, area.MaxX + 0.01); area.MinY = std::max(-90.0, area.MinY - 0.01); area.MaxY = std::min(90.0, area.MaxY + 0.01);
		auto *ctx = proj_context_create(); proj_context_set_enable_network(ctx, 0); const char *search[] = {"/usr/share/proj"}; proj_context_set_search_paths(ctx, 1, search);
		PJ *src = source_object(ctx, source.get()), *dst = proj_create(ctx, "OGC:CRS84");
		auto *factory = proj_create_operation_factory_context(ctx, nullptr); proj_operation_factory_context_set_grid_availability_use(ctx, factory, PROJ_GRID_AVAILABILITY_IGNORED);
		proj_operation_factory_context_set_area_of_interest(ctx, factory, area.MinX, area.MinY, area.MaxX, area.MaxY); proj_operation_factory_context_set_spatial_criterion(ctx, factory, PROJ_SPATIAL_CRITERION_STRICT_CONTAINMENT);
		bool sourceAreaKnown = false, sourceAreaFits = src && object_area(ctx, src, area, sourceAreaKnown);
		auto *list = src && dst ? proj_create_operations(ctx, src, dst, factory) : nullptr; PJ *selected = nullptr;
		if (list && (!sourceAreaKnown || sourceAreaFits)) for (int i = 0; i < proj_list_get_count(list); i++) {
			auto *op = proj_list_get(ctx, list, i); bool usable = proj_coordoperation_is_instantiable(ctx, op), ballpark = proj_coordoperation_has_ballpark_transformation(ctx, op);
			bool operationAreaKnown = false, applicable = object_area(ctx, op, area, operationAreaKnown);
			// Unit/axis/projection conversions have no regional datum parameters.
			// A synthetic ballpark offset is allowed only within a known source area.
			if (!operationAreaKnown) applicable = conversions_only(ctx, op) || (allow && ballpark && sourceAreaFits);
			if (!applicable) { proj_destroy(op); continue; }
			if (usable && (allow || !ballpark)) { selected = op; break; } proj_destroy(op); if (!allow) break;
		}
		if (selected) {
			const char *pipeline = proj_as_proj_string(ctx, selected, PJ_PROJ_5, nullptr); OGRCoordinateTransformationOptions settings; settings.SetBallparkAllowed(allow);
			if (pipeline && settings.SetCoordinateOperation(pipeline, false)) transform.reset(OGRCreateCoordinateTransformation(source.get(), &target, settings));
			if (transform) { J op = J::object(); op.set("engine", "GDAL " + std::string(GDALVersionInfo("RELEASE_NAME")) + " / PROJ " + proj_info().version); op.set("policy", allow ? "approximate" : "strict"); op.set("identity", proj_get_name(selected) ? J(proj_get_name(selected)) : J()); double accuracy = proj_coordoperation_get_accuracy(ctx, selected); op.set("accuracy", accuracy >= 0 ? J(std::to_string(accuracy) + " m (operation metadata)") : J()); json.set("operation", op); }
		}
		if (!transform) { reasons.add(sourceAreaKnown && !sourceAreaFits ? "Source coordinates are outside the declared CRS area of use." : allow ? "No applicable installed transformation covers the source geographic area." : "Strict transformation is unavailable: the preferred applicable operation needs missing grids or a ballpark transformation."); json.set("operation", J()); }
		proj_destroy(selected); proj_list_destroy(list); proj_operation_factory_context_destroy(factory); proj_destroy(src); proj_destroy(dst); proj_context_destroy(ctx);
	}
	void feature(const OGRGeometry *native, const std::string &locator, const Limits &limits) {
		if (!native || native->IsEmpty()) { empty++; return; } drawable++; if (!transform) return;
		Geometry g(native->clone()); CPLErrorReset(); if (g->transform(transform.get()) != OGRERR_NONE) { reasons.add("A source feature could not be transformed to CRS84."); return; }
		try { GeometryBudget budget{0, 0, limits}; J j = geometry_json(g.get(), budget, true); OGREnvelope e; g->getEnvelope(&e); display.set(locator, j); if (!hasBounds) { bounds = e; hasBounds = true; } else bounds.Merge(e); displayed++; }
		catch (const Failure &e) { if (e.reason != "gis_display_domain" && e.reason != "gis_geometry_invalid") throw; reasons.add("A transformed source feature is outside the finite CRS84 geographic domain."); }
	}
	J finish(int sourceFeatures) {
		json.set("state", transform && displayed == drawable ? "ready" : "unavailable"); json.set("displayByLocator", display); json.set("extent", hasBounds ? extent(bounds) : J());
		J coverage = J::object(); coverage.set("sourceFeatures", sourceFeatures); coverage.set("retainedDrawable", drawable); coverage.set("nullOrEmpty", empty); coverage.set("decodeOmitted", 0); coverage.set("displayed", displayed); json.set("coverage", coverage); json.set("reasons", reasons); return json;
	}
};
static J vector_preview(GDALDataset *ds, const J &options, const Limits &limits, bool formatConvention, bool unknownCrs, const J &rawDeclaration) {
	if (!options.is(json_type_object)) reject("gis_invalid_options", "Display options must be an object.");
	J suppliedEnvironment = options.get("environmentFingerprint"); if (!suppliedEnvironment.null() && suppliedEnvironment.str() != fingerprint) reject("gis_environment_changed", "Display options refer to a different installed projection environment.");
	layer_count(ds); J layers = J::array(), result = J::object(); int64_t featureTotal = 0; GeometryBudget geometryBudget{0, 0, limits};
	J assumed = options.get("sourceCrs"); if (!assumed.null()) { std::string id = assumed.get("layerId").str(); if (!std::regex_match(id, std::regex("layer-(0|[1-9][0-9]?)")) || std::stoi(id.substr(6)) >= ds->GetLayerCount()) reject("gis_invalid_options", "Assumed CRS layer does not exist."); }
	for (int i = 0; i < ds->GetLayerCount(); i++) {
		auto *l = get_layer(ds, i); std::string id = "layer-" + std::to_string(i); Placement placement(l, id, options, formatConvention, unknownCrs); l->ResetReading(); std::vector<std::pair<std::string, Geometry>> geometries;
		J features = J::array(); std::set<std::string> types; OGREnvelope nativeBounds; bool hasBounds = false; int ordinal = 0; int64_t positionsBefore = geometryBudget.positions;
		while (auto f = next(l)) {
			if (++featureTotal > limits.features) reject("vector_feature_limit", "Complete geometry exceeds the feature ceiling; use attribute pages.");
			std::string locator = id + ":" + std::to_string(ordinal++); const auto *g = f->GetGeometryRef(); J native = geometry_json(g, geometryBudget);
			J j = J::object(); j.set("locator", locator); if (f->GetFID() != OGRNullFID) j.set("sourceId", std::to_string(f->GetFID())); j.set("geometry", native); j.set("properties", properties(f.get(), limits, "vector_response_limit"));
			if (g) { j.set("coordinateDimensions", g->Is3D() ? (g->IsMeasured() ? "XYZM" : "XYZ") : (g->IsMeasured() ? "XYM" : "XY")); types.insert(OGRGeometryTypeToName(g->getGeometryType())); if (!g->IsEmpty()) { OGREnvelope e; g->getEnvelope(&e); if (!hasBounds) { nativeBounds = e; hasBounds = true; } else nativeBounds.Merge(e); } }
			features.add(j); geometries.emplace_back(locator, g ? g->clone() : nullptr); response_bound(features, limits, "vector_response_limit");
		}
		placement.prepare(geometries); for (const auto &[locator, g] : geometries) placement.feature(g.get(), locator, limits);
		J layer = J::object(), defs = fields(l), names = J::array(), geometryTypes = J::array(); for (int n = 0; n < defs.size(); n++) names.add(defs.at(n).get("name")); for (const auto &t : types) geometryTypes.add(t);
		layer.set("id", id); layer.set("name", l->GetName()); layer.set("features", features); layer.set("fields", names); layer.set("fieldDefinitions", defs); layer.set("geometryTypes", geometryTypes); layer.set("extent", hasBounds ? extent(nativeBounds) : J()); layer.set("positionCount", geometryBudget.positions - positionsBefore); layer.set("coordinateLabel", "Native source coordinates");
		J declarations = J::array(); if (!formatConvention && (!rawDeclaration.null() || unknownCrs)) { J d = J::object(); d.set("format", "GeoJSON"); d.set("value", rawDeclaration); declarations.add(d); } if (l->GetSpatialRef() && !unknownCrs) { J d = J::object(); d.set("wkt", wkt(l->GetSpatialRef())); d.set("axisMapping", axis_mapping(l->GetSpatialRef())); declarations.add(d); } layer.set("crsDeclarations", declarations);
		J placed = placement.finish(ordinal); layer.set("placement", placed); layer.set("plotWarning", placed.get("state").str() == "ready" ? J() : J("Geographic placement is unavailable for some or all source features.")); layers.add(layer); response_bound(layers, limits, "vector_response_limit");
	}
	result.set("schemaVersion", 3); result.set("parser", VECTOR_PARSER); result.set("displayOptions", options); result.set("layers", layers); result.set("coverage", "Complete native feature geometry and attributes within advertised limits; geographic placement has separate coverage."); result.set("warnings", J::array()); response_bound(result, limits, "vector_response_limit"); return result;
}
static J mask_flags(int flags) { J j = J::array(); if (flags & GMF_ALL_VALID) j.add("all-valid"); if (flags & GMF_PER_DATASET) j.add("per-dataset"); if (flags & GMF_ALPHA) j.add("alpha"); if (flags & GMF_NODATA) j.add("nodata"); return j; }
static J band_nodata(GDALRasterBand *band) {
	int valid = 0;
	if (band->GetRasterDataType() == GDT_Int64) { int64_t value = band->GetNoDataValueAsInt64(&valid); return valid ? exact(value) : J(); }
	if (band->GetRasterDataType() == GDT_UInt64) { uint64_t value = band->GetNoDataValueAsUInt64(&valid); return valid ? (value <= 9007199254740991ULL ? J(static_cast<int64_t>(value)) : J(std::to_string(value))) : J(); }
	double value = band->GetNoDataValue(&valid); return valid ? numeric(value) : J();
}
static void block_budget(GDALRasterBand *band, const Limits &limits) {
	if (band->GetOverviewCount() > 64) reject("gis_metadata_limit", "Raster overview count exceeds its ceiling.");
	for (int i = -1; i < band->GetOverviewCount(); i++) {
		auto *b = i < 0 ? band : band->GetOverview(i); if (!b) reject("gis_decode_failed", "Raster overview is invalid."); int x, y; b->GetBlockSize(&x, &y);
		int64_t pixels = int64_t(x) * y;
		if (x < 1 || y < 1 || pixels > limits.sourcePixels) reject("raster_block_limit", "Expanded raster block pixels exceed their ceiling.");
		int64_t bytes = pixels * std::max(1, GDALGetDataTypeSizeBytes(b->GetRasterDataType()));
		if (bytes > limits.decodedBlockBytes) reject("raster_block_limit", "Expanded raster block bytes exceed their ceiling.");
		if (int64_t(b->GetXSize()) * b->GetYSize() > limits.sourcePixels) reject("raster_pixel_limit", "Raster or overview dimensions exceed the source pixel ceiling.");
	}
}
static int64_t decoded_work(GDALRasterBand *band, int outWidth, int outHeight) {
	int64_t worst = 0;
	for (int i = -1; i < band->GetOverviewCount(); i++) {
		auto *b = i < 0 ? band : band->GetOverview(i); int x, y; b->GetBlockSize(&x, &y);
		int64_t columns = (int64_t(b->GetXSize()) + x - 1) / x, rows = (int64_t(b->GetYSize()) + y - 1) / y;
		int64_t blocks = std::min(columns, int64_t(outWidth)) * std::min(rows, int64_t(outHeight));
		worst = std::max(worst, blocks * x * y * std::max(1, GDALGetDataTypeSizeBytes(b->GetRasterDataType())));
	}
	return worst;
}
static J raster_preview(GDALDataset *ds, const J &options, const Limits &limits) {
	int width = ds->GetRasterXSize(), height = ds->GetRasterYSize(), bands = ds->GetRasterCount();
	if (width < 1 || height < 1 || int64_t(width) * height > limits.sourcePixels) reject("raster_pixel_limit", "Raster source dimensions exceed the pixel ceiling.");
	if (bands < 1 || bands > limits.bands) reject("raster_band_limit", "Raster band count exceeds its ceiling.");
	int selected = static_cast<int>(option_integer(options, "band", 1, 1, bands)); J metadata = J::array(); int64_t expanded = 0;
	double factor = std::min(1.0, double(limits.previewEdge) / std::max(width, height)); int outWidth = std::max(1, static_cast<int>(std::floor(width * factor))), outHeight = std::max(1, static_cast<int>(std::floor(height * factor))); size_t pixels = size_t(outWidth) * outHeight;
	for (int i = 1; i <= bands; i++) {
		auto *b = ds->GetRasterBand(i); block_budget(b, limits); block_budget(b->GetMaskBand(), limits); int x, y; b->GetBlockSize(&x, &y); expanded += int64_t(x) * y * std::max(1, GDALGetDataTypeSizeBytes(b->GetRasterDataType()));
		if (expanded > limits.decodedBlockBytes) reject("raster_block_limit", "Combined expanded raster blocks exceed their ceiling.");
		J j = J::object(); int valid; j.set("nodata", band_nodata(b)); double n = b->GetScale(&valid); j.set("scale", valid ? numeric(n) : J()); n = b->GetOffset(&valid); j.set("offset", valid ? numeric(n) : J());
		j.set("band", i); j.set("description", b->GetDescription()); j.set("dataType", GDALGetDataTypeName(b->GetRasterDataType())); j.set("unit", std::strlen(b->GetUnitType()) ? J(b->GetUnitType()) : J()); j.set("colorInterpretation", GDALGetColorInterpretationName(b->GetColorInterpretation())); j.set("colorTableEntries", b->GetColorTable() ? b->GetColorTable()->GetColorEntryCount() : 0); j.set("maskFlags", mask_flags(b->GetMaskFlags()));
		J overviews = J::array(); if (b->GetOverviewCount() > 64) reject("gis_metadata_limit", "Raster overview count exceeds its ceiling."); for (int k = 0; k < b->GetOverviewCount(); k++) { J o = J::object(); o.set("width", b->GetOverview(k)->GetXSize()); o.set("height", b->GetOverview(k)->GetYSize()); overviews.add(o); } j.set("overviews", overviews); metadata.add(j);
	}
	auto *band = ds->GetRasterBand(selected); if (GDALDataTypeIsComplex(band->GetRasterDataType()) || band->GetRasterDataType() == GDT_Int64 || band->GetRasterDataType() == GDT_UInt64) reject("raster_type_unsupported", "Complex and 64-bit integer samples require a display treatment outside this Float64 grayscale preview.");
	// Conservatively account for all interleaved channels and the sampled mask.
	// The worst possible GDAL-auto level must fit, before RasterIO decompresses it.
	if (decoded_work(band, outWidth, outHeight) * bands + decoded_work(band->GetMaskBand(), outWidth, outHeight) > limits.decodedBlockBytes) reject("raster_block_limit", "Total expanded sampled block work exceeds its ceiling.");
	std::vector<double> values(pixels); std::vector<unsigned char> masks(pixels), rgba(pixels * 4);
	GDALRasterIOExtraArg extra; INIT_RASTERIO_EXTRA_ARG(extra); extra.eResampleAlg = GRIORA_NearestNeighbour;
	if (band->RasterIO(GF_Read, 0, 0, width, height, values.data(), outWidth, outHeight, GDT_Float64, 0, 0, &extra) != CE_None || band->GetMaskBand()->RasterIO(GF_Read, 0, 0, width, height, masks.data(), outWidth, outHeight, GDT_Byte, 0, 0, &extra) != CE_None) reject("gis_decode_failed", "Selected band or mask could not be decoded.");
	int hasNodata; double nodata = band->GetNoDataValue(&hasNodata), min = std::numeric_limits<double>::infinity(), max = -min; bool any = false;
	for (size_t i = 0; i < pixels; i++) { if (!std::isfinite(values[i]) || (hasNodata && (std::isnan(nodata) ? std::isnan(values[i]) : values[i] == nodata))) masks[i] = 0; if (masks[i]) { any = true; min = std::min(min, values[i]); max = std::max(max, values[i]); } }
	for (size_t i = 0; i < pixels; i++) { unsigned char grey = masks[i] && max > min ? static_cast<unsigned char>(std::round(255.0L * std::clamp((static_cast<long double>(values[i])-min)/(static_cast<long double>(max)-min), 0.0L, 1.0L))) : 0; rgba[i*4] = rgba[i*4+1] = rgba[i*4+2] = grey; rgba[i*4+3] = masks[i]; }
	Dataset image(GetGDALDriverManager()->GetDriverByName("MEM")->Create("", outWidth, outHeight, 4, GDT_Byte, nullptr), GDALClose); if (!image) reject("gis_resource_limit", "PNG memory allocation failed.");
	for (int i = 0; i < 4; i++) { image->GetRasterBand(i+1)->SetColorInterpretation(static_cast<GDALColorInterp>(GCI_RedBand + i)); if (image->GetRasterBand(i+1)->RasterIO(GF_Write, 0, 0, outWidth, outHeight, rgba.data()+i, outWidth, outHeight, GDT_Byte, 4, outWidth*4) != CE_None) reject("gis_decode_failed", "PNG channel generation failed."); }
	Dataset png(GetGDALDriverManager()->GetDriverByName("PNG")->CreateCopy("/vsimem/preview.png", image.get(), FALSE, nullptr, nullptr, nullptr), GDALClose); if (!png) reject("gis_decode_failed", "PNG encoding failed."); png.reset(); vsi_l_offset bytes; auto *encoded = VSIGetMemFileBuffer("/vsimem/preview.png", &bytes, FALSE); if (!encoded || bytes > static_cast<uint64_t>(limits.responseBytes)) reject("gis_response_limit", "PNG exceeds response ceiling.");
	char *base64 = CPLBase64Encode(static_cast<int>(bytes), encoded); std::string url = "data:image/png;base64," + std::string(base64); CPLFree(base64); VSIUnlink("/vsimem/preview.png");
	J result = J::object(); result.set("schemaVersion", 1); result.set("parser", "bounded-gdal-raster-v1"); result.set("driver", ds->GetDriverName()); result.set("driverVersion", GDALVersionInfo("RELEASE_NAME")); result.set("width", width); result.set("height", height); result.set("bandCount", bands); result.set("bands", metadata); result.set("crsWkt", wkt(const_cast<OGRSpatialReference *>(ds->GetSpatialRef())));
	double gt[6]; J geoTransform; if (ds->GetGeoTransform(gt) == CE_None) { geoTransform = J::array(); for (double v : gt) { if (!std::isfinite(v)) reject("gis_metadata_invalid", "Native raster geotransform contains a nonfinite value."); geoTransform.add(v); } } result.set("geoTransform", geoTransform);
	J im = J::object(), stretch = J::object(); stretch.set("kind", "sample-min-max"); stretch.set("minimum", any ? J(min) : J()); stretch.set("maximum", any ? J(max) : J()); im.set("band", selected); im.set("width", outWidth); im.set("height", outHeight); im.set("dataUrl", url); im.set("resampling", "nearest"); im.set("overviewSelection", "GDAL-auto"); im.set("stretch", stretch); im.set("scaleOffsetApplied", false); im.set("colorTableApplied", false); result.set("image", im);
	J caps = J::object(); caps.set("inputBytes", limits.inputBytes); caps.set("bands", limits.bands); caps.set("previewEdge", limits.previewEdge); caps.set("outputBytes", limits.responseBytes); caps.set("memoryBytes", 512 * MIB); caps.set("timeoutMs", 30000); result.set("limits", caps); result.set("coverage", "Nearest sampled selected-band grayscale; masks and nodata are transparent."); result.set("warnings", strings({"Sample minimum and maximum define the grayscale stretch. Band scale, offset, and color table are not applied."})); response_bound(result, limits, "gis_response_limit"); return result;
}
#include "raster-map.hpp"
#include "assay.hpp"
static J process(const Members &members, const std::string &primary, const std::string &kind, const std::string &operation, const J &options, const Limits &limits, const J &memberNames = J()) {
	if (kind == "assay") return assay_process(members, primary, options, limits, memberNames);
	std::string driver = validate_bundle(members, primary, kind); bool convention = false, unknownCrs = false; J rawDeclaration;
	if (driver == "GeoJSON") {
		const auto &bytes = members.at(primary); std::string_view original(reinterpret_cast<const char *>(bytes.data()), bytes.size()); validate_json_tokens(original);
		auto declaration = json_member(original, "crs"); convention = !declaration.has_value();
		if (declaration) { if (declaration->size() > 65536) reject("gis_metadata_limit", "GeoJSON CRS declaration exceeds its metadata ceiling."); rawDeclaration = J::parse(std::string(*declaration)); }
		if (!convention) {
			if (rawDeclaration.get("type").str() == "link") reject("gis_bundle_invalid", "External GeoJSON CRS links are not captured dependencies.");
			std::string name = rawDeclaration.get("properties").get("name").str();
			bool authority = std::regex_match(name, std::regex("EPSG:[1-9][0-9]{0,6}|OGC:CRS84|urn:ogc:def:crs:EPSG:[0-9.]*:[1-9][0-9]{0,6}|urn:ogc:def:crs:OGC:[0-9.]*:CRS84", std::regex::icase));
			OGRSpatialReference declared; unknownCrs = rawDeclaration.get("type").str() != "name" || !authority || declared.SetFromUserInput(name.c_str()) != OGRERR_NONE;
		}
	}
	Vsimem files(members); Dataset ds = open_dataset(members, primary, kind, driver);
	if (kind == "raster") return operation == "map-display" ? raster_map_display(ds.get(), options, limits, members.at(primary)) : raster_preview(ds.get(), options, limits);
	if (primary.size() > 4 && primary.substr(primary.size()-4) == ".mif") { auto n = get_layer(ds.get(), 0)->GetFeatureCount(TRUE); if (n < 0 || n != mid_rows(members.at(stem(primary) + ".mid"))) reject("gis_bundle_invalid", "MIF geometry and MID attribute row counts disagree."); }
	if (operation == "manifest") return vector_manifest(ds.get(), limits, unknownCrs);
	if (operation == "attributes") return vector_page(ds.get(), options, limits);
	return vector_preview(ds.get(), options.get("displayOptions").null() ? J::object() : options.get("displayOptions"), limits, convention, unknownCrs, rawDeclaration);
}
static bool denied_open(const char *path, int flags, int expected) { errno = 0; int fd = open(path, flags, 0600); if (fd >= 0) { close(fd); return false; } return errno == expected; }
static bool filesystem_denied() {
	struct stat sentinel;
	return denied_open("/etc/passwd", O_RDONLY, ENOENT) && denied_open("/proc/self/environ", O_RDONLY, ENOENT) &&
		denied_open("../../../etc/passwd", O_RDONLY, ENOENT) && denied_open("../../../proc/self/environ", O_RDONLY, ENOENT) &&
		lstat("/.geocluster-isolation-sentinel", &sentinel) == 0 && S_ISREG(sentinel.st_mode) &&
		sentinel.st_uid == 0 && sentinel.st_gid == 0 && (sentinel.st_mode & 07777) == 0 &&
		denied_open("/.geocluster-isolation-sentinel", O_RDONLY, EACCES);
}
static bool writes_denied() {
	for (int flags : {O_WRONLY, O_RDWR, O_RDONLY | O_CREAT, O_RDONLY | O_TRUNC, O_TMPFILE | O_RDWR}) {
		if (!denied_open("/nonexistent-gis-write-probe", flags, EPERM)) return false;
		errno = 0; auto fd = syscall(SYS_openat, AT_FDCWD, "/nonexistent-gis-write-probe", flags, 0600);
		if (fd != -1 || errno != EPERM) { if (fd >= 0) close(fd); return false; }
	}
	errno = 0;
	return syscall(SYS_openat2, AT_FDCWD, "/nonexistent-gis-probe", nullptr, 0) == -1 && errno == ENOSYS &&
		syscall(SYS_mkdirat, AT_FDCWD, "/nonexistent-gis-directory", 0700) == -1 && errno == EPERM &&
		syscall(SYS_fchmodat, AT_FDCWD, "/.geocluster-isolation-sentinel", 0) == -1 && errno == EPERM;
}
static J qualify() {
	J probe = J::object(); probe.set("filesystemDenied", filesystem_denied()); probe.set("writeDenied", writes_denied());
	errno = 0; int status = truncate("/tmp/gis-native-truncate-probe", 0); probe.set("truncateDenied", status == -1 && errno == EPERM);
	errno = 0; status = ftruncate(0, 0); probe.set("descriptorTruncateDenied", status == -1 && errno == EPERM);
	errno = 0; int fd = socket(AF_INET, SOCK_STREAM, 0); probe.set("socketDenied", fd == -1 && errno == EPERM); if (fd >= 0) close(fd);
	char *const args[] = {const_cast<char *>("/nonexistent-gis-denial-probe"), nullptr}, *const env[] = {nullptr}; errno = 0; status = execve(args[0], args, env); probe.set("executionDenied", status == -1 && errno == EPERM);
	errno = 0; auto pid = syscall(SYS_clone, SIGCHLD, nullptr, nullptr, nullptr, 0); probe.set("processDenied", pid == -1 && errno == EPERM);
	errno = 0; status = kill(getpid(), 0); bool signalDenied = status == -1 && errno == EPERM;
	int deathSignal = 0;
	signalDenied = signalDenied && prctl(PR_GET_PDEATHSIG, &deathSignal, 0, 0, 0) == 0 && deathSignal == SIGKILL;
	errno = 0; status = prctl(PR_SET_PDEATHSIG, 0, 0, 0, 0); probe.set("signalDenied", signalDenied && status == -1 && errno == EPERM);
	for (const char *flag : {"filesystemDenied", "writeDenied", "truncateDenied", "descriptorTruncateDenied", "socketDenied", "executionDenied", "processDenied", "signalDenied"})
		if (!probe.get(flag).boolean()) reject("worker_unavailable", "Installed GIS confinement denial probes failed.");
	J decoded = J::array();
	for (const auto &p : {std::pair{"points.geojson", "GeoJSON"}, {"points.shp", "ESRI Shapefile"}, {"points.tab", "MapInfo File: TAB"}, {"points.mif", "MapInfo File: MIF"}, {"points.gpkg", "GPKG"}, {"pixels.tif", "GTiff"}, {"pixels.ers", "ERS"}}) {
		Members members; std::string primary = p.first; members[primary] = PROBE_FILES.at(primary);
		std::vector<std::string> names;
		if (primary == "points.shp") names = {"points.shx", "points.dbf", "points.prj"}; if (primary == "points.tab") names = {"points.dat", "points.map", "points.id"}; if (primary == "points.mif") names = {"points.mid"}; if (primary == "pixels.ers") names = {"pixels"};
		for (const auto &n : names) members[n] = PROBE_FILES.at(n);
		bool raster = primary.rfind("pixels", 0) == 0; J result = process(members, primary, raster ? "raster" : "vector", "preview", J::object(), Limits());
		if (raster ? result.get("width").integer() != 4 || result.get("image").get("dataUrl").str().rfind("data:image/png;base64,", 0) != 0 : result.get("layers").at(0).get("features").size() != 3 || result.get("layers").at(0).get("features").at(0).get("properties").get("label").str() != "first" || result.get("layers").at(0).get("placement").get("state").str() != "ready" || std::abs(result.get("layers").at(0).get("placement").get("displayByLocator").get("layer-0:0").get("coordinates").at(0).number() - 10) > 0.00001) reject("worker_unavailable", "Installed genuine-fixture decode/placement probe failed.");
		decoded.add(p.second);
	}
	probe.set("decoded", decoded); assay_qualify(probe); return probe;
}
int main() {
	try {
		install_seccomp(); if (getuid() != 997 || geteuid() != 997) reject("worker_unavailable", "Worker identity is not the installed preview UID.");
		for (int fd = 3; fd < 64; fd++) if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) reject("worker_unavailable", "Worker inherited a non-IPC descriptor.");
		CPLSetConfigOption("GDAL_DRIVER_PATH", "disable"); CPLSetConfigOption("PROJ_NETWORK", "OFF"); CPLSetConfigOption("GDAL_PAM_ENABLED", "NO"); CPLSetConfigOption("SHAPE_RESTORE_SHX", "NO"); CPLSetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "TRUE"); CPLSetConfigOption("OGR_SQLITE_LOAD_EXTENSIONS", ""); CPLSetConfigOption("OGR_SQLITE_PRAGMA", "temp_store=MEMORY,trusted_schema=OFF"); CPLSetConfigOption("OGR_SQLITE_CACHE", "8"); CPLSetConfigOption("GDAL_NUM_THREADS", "1"); CPLSetConfigOption("CPL_TMPDIR", "/vsimem"); GDALSetCacheMax64(32 * MIB);
		const char *search[] = {"/usr/share/proj", nullptr}; OSRSetPROJSearchPaths(search); OSRSetPROJEnableNetwork(FALSE); GDALAllRegister(); CPLPushErrorHandler(CPLQuietErrorHandler); fingerprint = environment_hash();
		J ready = J::object(); ready.set("ready", true); ready.set("parser", VECTOR_PARSER); ready.set("uid", static_cast<int>(getuid())); ready.set("pid", static_cast<int>(getpid())); ready.set("confinement", "installed"); std::cout << ready.dump() << '\n' << std::flush;
		std::string line; for (int i = 0; i <= 16384; i++) { int c = std::cin.get(); if (c == '\n') break; if (c == EOF || i == 16384) reject("gis_protocol_invalid", "IPC header is missing or exceeds 16 KiB."); line.push_back(static_cast<char>(c)); }
		J header = J::parse(line); if (!header.is(json_type_object)) reject("gis_protocol_invalid", "IPC header must be an object."); Limits limits(header.get("limits")); J terminal = J::object();
		if (header.get("probe").boolean()) { if (std::cin.get() != EOF) reject("gis_protocol_invalid", "Qualification cannot receive input bytes."); terminal.set("probe", qualify()); terminal.set("build", build_info()); }
		else {
			std::string kind = header.get("kind").str(), operation = header.get("operation").str(), primary = lower(header.get("primary").str());
			if ((kind != "vector" && kind != "raster" && kind != "assay") || (operation != "manifest" && operation != "preview" && operation != "attributes" && !(kind == "raster" && operation == "map-display")) || (kind != "vector" && operation == "attributes") || (kind == "assay" && operation != "manifest")) reject("gis_invalid_options", "Unsupported kind or operation.");
			limits.responseBytes = kind == "assay" ? std::min(limits.responseBytes, limits.assayResponseBytes) : std::min(limits.responseBytes, 2 * MIB);
			J list = header.get("members"), options = header.get("options"); if (!list.is(json_type_array) || list.size() < 1 || list.size() > limits.members || !options.is(json_type_object)) reject("gis_protocol_invalid", "Invalid members or options.");
			Members members; J memberNames = J::object(); int64_t total = 0; std::vector<std::pair<std::string, int64_t>> lengths;
			for (int i = 0; i < list.size(); i++) {
				J item = list.at(i), length = item.get("byteLength"); std::string name = lower(item.get("name").str());
				if (!basename(name) || members.count(name) || !length.is(json_type_int) || length.integer() < 0 || length.integer() > limits.inputBytes) reject("gis_bundle_invalid", "Invalid, duplicate, or oversized member declaration.");
				memberNames.set(name, item.get("name"));
				total += length.integer(); if (total > limits.inputBytes) reject("gis_input_limit", "Aggregate input exceeds its physical ceiling."); members[name] = {}; lengths.push_back({name, length.integer()});
			}
			if (primary != lengths[0].first) reject("gis_bundle_invalid", "Primary must be the first captured member.");
			for (auto &[name, length] : lengths) { members[name].resize(length); std::cin.read(reinterpret_cast<char *>(members[name].data()), length); if (std::cin.gcount() != length) reject("source_integrity", "Member stream ended before the declared length."); }
			if (std::cin.get() != EOF) reject("source_integrity", "Undeclared trailing input bytes.");
			terminal.set("payload", process(members, primary, kind, operation, options, limits, memberNames)); response_bound(terminal, limits, kind == "assay" ? "assay_response_limit" : kind == "vector" && operation == "preview" ? "vector_response_limit" : "gis_response_limit");
		}
		std::cout << terminal.dump() << '\n' << std::flush; return 0;
	} catch (const Failure &failure) { J error = J::object(), result = J::object(); error.set("reason", failure.reason); error.set("message", failure.what()); result.set("error", error); std::cout << result.dump() << '\n' << std::flush; return 0; }
	catch (const std::bad_alloc &) { std::cout << "{\"error\":{\"reason\":\"gis_resource_limit\",\"message\":\"Native memory ceiling reached.\"}}\n" << std::flush; return 0; }
	catch (...) { std::cout << "{\"error\":{\"reason\":\"gis_decode_failed\",\"message\":\"Invalid native input or bounded IPC.\"}}\n" << std::flush; return 0; }
}
