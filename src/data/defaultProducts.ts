// Default product data - will be overridden when Google Sheets is connected
export interface Product {
  sku: string;
  brand: string;
  exampleTitle: string;
}

export const defaultProducts: Product[] = [
  { sku: "LED-DL-001", brand: "LumiPro", exampleTitle: "10W LED Downlight - White 3000K" },
  { sku: "LED-DL-002", brand: "LumiPro", exampleTitle: "15W LED Downlight - Black 4000K" },
  { sku: "LED-SP-001", brand: "BrightEdge", exampleTitle: "7W GU10 Spotlight - Warm White" },
  { sku: "LED-SP-002", brand: "BrightEdge", exampleTitle: "5W MR16 Spotlight - Cool White" },
  { sku: "LED-PD-001", brand: "AuraLux", exampleTitle: "Modern Pendant Light - Brass Finish" },
  { sku: "LED-PD-002", brand: "AuraLux", exampleTitle: "Industrial Pendant - Matte Black" },
  { sku: "LED-WL-001", brand: "WallGlow", exampleTitle: "Up/Down Wall Light - Silver IP65" },
  { sku: "LED-WL-002", brand: "WallGlow", exampleTitle: "LED Wall Sconce - Chrome" },
  { sku: "LED-FL-001", brand: "FloodMax", exampleTitle: "50W LED Flood Light - IP66" },
  { sku: "LED-FL-002", brand: "FloodMax", exampleTitle: "100W LED Flood Light - IP67" },
  { sku: "LED-ST-001", brand: "StripTech", exampleTitle: "5M RGB LED Strip - 12V" },
  { sku: "LED-ST-002", brand: "StripTech", exampleTitle: "5M Warm White Strip - 24V" },
  { sku: "LED-CH-001", brand: "AuraLux", exampleTitle: "Crystal Chandelier - 8 Arm Gold" },
  { sku: "LED-TK-001", brand: "TrackLine", exampleTitle: "3-Phase Track Spotlight - 15W" },
  { sku: "LED-PN-001", brand: "LumiPro", exampleTitle: "600x600 Panel Light - 40W" },
  { sku: "LED-BL-001", brand: "GlobeMaster", exampleTitle: "E27 A60 LED Bulb - 9W 3000K" },
  { sku: "LED-BL-002", brand: "GlobeMaster", exampleTitle: "E14 Candle LED - 5W Dimmable" },
  { sku: "LED-HB-001", brand: "IndustraLight", exampleTitle: "200W LED High Bay - IP65" },
  { sku: "LED-GL-001", brand: "GardenGlow", exampleTitle: "LED Bollard Light - 600mm" },
  { sku: "LED-GL-002", brand: "GardenGlow", exampleTitle: "Solar Path Light - Stainless" },
];
