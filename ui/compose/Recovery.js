.pragma library

// Presentation initial state only. Rust validates and stores recovery records.
function empty() {
  return { active: false, returnView: "", draft: null, parked: [] }
}
