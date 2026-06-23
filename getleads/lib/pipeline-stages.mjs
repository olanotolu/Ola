export const PIPELINE_STAGES = [
  { id: "research", label: "Research", hint: "New leads to qualify" },
  { id: "targeted", label: "Targeted", hint: "Fit confirmed, ready for outreach" },
  { id: "contacted", label: "Contacted", hint: "Outreach sent" },
  { id: "connected", label: "Connected", hint: "LinkedIn connect or reply" },
  { id: "meeting", label: "Meeting", hint: "Call or demo scheduled" },
  { id: "pilot", label: "Pilot", hint: "Active trial / pilot" },
  { id: "customer", label: "Customer", hint: "Paying customer" },
  { id: "lost", label: "Lost", hint: "Not a fit or no response" },
];

export const PIPELINE_STAGE_IDS = new Set(PIPELINE_STAGES.map((s) => s.id));

export function normalizePipelineStage(stage) {
  const s = (stage || "research").toLowerCase().trim();
  return PIPELINE_STAGE_IDS.has(s) ? s : "research";
}
