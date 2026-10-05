#include "record.h"
#include <vector>

int nextId(const std::vector<Record>& rs) {
  int max = 0;
  for (const auto& r : rs) if (r.id > max) max = r.id;
  return max + 1;
}
