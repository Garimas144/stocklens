// Starting points for a new camera. Missing rule keys are filled from the profile defaults by the worker (cameras.py).
const rect = (x1: number, y1: number, x2: number, y2: number) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

export function templateFor(profile: "shelf" | "movement") {
  if (profile === "shelf")
    return {
      zones: [{ id: "shelf_1", label: "Shelf 1", role: "shelf", polygon: rect(400, 300, 1500, 800), location_id: "SHELF-X", fully_visible: true }],
      count_lines: [],
      rules: { box_prompts: ["cardboard box"], track_people: true },
    };
  return {
    zones: [],
    count_lines: [{ id: "gate", label: "Gate", p1: [960, 300], p2: [960, 900], forward: [1, 0], forward_means: "outbound", location_id: "CHECKPOINT-X" }],
    rules: { box_prompts: ["cardboard box", "parcel"], track_people: false, flow: [1, 0], expected_routes: [], required_checkpoint: false },
  };
}
