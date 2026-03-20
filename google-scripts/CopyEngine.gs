/*************************************************************
 * COPY ENGINE — SUBMIT PIPELINE DISABLED
 *
 * Submit / override / upload are completed directly in the
 * edge function. This Apps Script file is intentionally kept
 * as a no-op shim so any legacy trigger, manual run, or stale
 * Execution API call cannot mutate OUTPUT_Work or Loading Dock.
 *************************************************************/

var COPY_ENGINE = {
  EDGE_OWNS_SUBMIT_PIPELINE: true,
  TEMPLATE_SHEET: "OUTPUT_Template",
  WORK_SHEET: "OUTPUT_Work",
  TEMP_SHEET: "Loading Dock",
};

function processSubmitEvents() {
  console.log("processSubmitEvents: disabled — submit/upload are handled directly by the edge function.");
  return {
    ok: true,
    skipped: true,
    reason: "edge_owned_submit_pipeline",
  };
}
