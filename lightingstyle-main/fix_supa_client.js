const fs = require('fs');
const file = 'src/lib/supabaseGoogleSheets.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /export async function fetchDockEntries\(\): Promise<DockEntry\[\]> \{/,
  "let _lastErrorsMap: Record<string, string> | null = null;\n\nexport function getLastErrorsMap(): Record<string, string> | null {\n  return _lastErrorsMap;\n}\n\nexport async function fetchDockEntries(): Promise<DockEntry[]> {"
);

code = code.replace(
  /entries\?: DockEntry\[\]; formDataMap\?: Record<string, OutputWorkFormData>;/,
  "entries?: DockEntry[]; formDataMap?: Record<string, OutputWorkFormData>; errors?: Record<string, string>;"
);

code = code.replace(
  /if \(data\?\.formDataMap\) \{\n\s*_lastFormDataMap = data\.formDataMap;\n\s*\}/,
  "if (data?.formDataMap) {\n        _lastFormDataMap = data.formDataMap;\n      }\n      if (data?.errors) {\n        _lastErrorsMap = data.errors;\n      }"
);

fs.writeFileSync(file, code);
