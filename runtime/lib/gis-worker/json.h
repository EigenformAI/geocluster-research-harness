#pragma once
#include <json-c/json.h>
#include <stdexcept>
#include <string>

class J {
	json_object *p = nullptr;
	explicit J(json_object *value, bool retain) : p(retain ? json_object_get(value) : value) {}
public:
	J() = default;
	J(const char *s) : p(json_object_new_string(s)) {}
	J(const std::string &s) : p(json_object_new_string_len(s.data(), static_cast<int>(s.size()))) {}
	J(bool b) : p(json_object_new_boolean(b)) {}
	J(int n) : p(json_object_new_int(n)) {}
	J(int64_t n) : p(json_object_new_int64(n)) {}
	J(double n) : p(json_object_new_double(n)) {}
	J(const J &v) : p(json_object_get(v.p)) {}
	J(J &&v) noexcept : p(v.p) { v.p = nullptr; }
	~J() { json_object_put(p); }
	J &operator=(J v) { std::swap(p, v.p); return *this; }
	static J object() { return J(json_object_new_object(), false); }
	static J array() { return J(json_object_new_array(), false); }
	static J parse(const std::string &s) {
		auto *t = json_tokener_new_ex(32); json_tokener_set_flags(t, JSON_TOKENER_STRICT);
		// The terminator completes standalone scalar tokens such as a null CRS.
		auto *p = json_tokener_parse_ex(t, s.c_str(), static_cast<int>(s.size()+1));
		bool valid = json_tokener_get_error(t) == json_tokener_success && json_tokener_get_parse_end(t) == s.size(); json_tokener_free(t);
		if (!valid) { json_object_put(p); throw std::runtime_error("Invalid bounded JSON"); } return J(p, false);
	}
	J get(const char *key) const { json_object *v = nullptr; if (p && json_object_is_type(p, json_type_object)) json_object_object_get_ex(p, key, &v); return J(v, true); }
	bool has(const char *key) const { json_object *v = nullptr; return p && json_object_is_type(p, json_type_object) && json_object_object_get_ex(p, key, &v); }
	J at(int i) const { return J(json_object_array_get_idx(p, i), true); }
	void set(const std::string &key, const J &v) { json_object_object_add(p, key.c_str(), json_object_get(v.p)); }
	void add(const J &v) { json_object_array_add(p, json_object_get(v.p)); }
	bool is(json_type type) const { return json_object_is_type(p, type); }
	bool null() const { return !p || is(json_type_null); }
	int size() const { return is(json_type_array) ? static_cast<int>(json_object_array_length(p)) : is(json_type_object) ? json_object_object_length(p) : 0; }
	std::string str() const { return is(json_type_string) ? std::string(json_object_get_string(p), json_object_get_string_len(p)) : ""; }
	int64_t integer() const { return json_object_get_int64(p); }
	double number() const { return json_object_get_double(p); }
	bool boolean() const { return json_object_get_boolean(p); }
	std::string dump() const { return p ? json_object_to_json_string_ext(p, JSON_C_TO_STRING_PLAIN) : "null"; }
	J map_scalars(J (*transform)(const J &)) const {
		if (is(json_type_array)) { J result = array(); for (int i = 0; i < size(); i++) result.add(at(i).map_scalars(transform)); return result; }
		if (is(json_type_object)) { J result = object(); json_object_object_foreach(p, key, value) { result.set(key, J(value, true).map_scalars(transform)); } return result; }
		return transform(*this);
	}
};
