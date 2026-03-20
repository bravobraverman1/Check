// Default property definitions - will be overridden when Google Sheets is connected

export type PropertyInputType = "dropdown" | "text" | "number" | "boolean";

export interface PropertyDefinition {
  name: string;
  key: string; // camelCase key for form data
  inputType: PropertyInputType;
  section: string;
  unitSuffix?: string;
  required?: boolean;
}

export interface LegalValue {
  propertyName: string;
  allowedValue: string;
}

export const defaultProperties: PropertyDefinition[] = [
  // Colours section
  { name: "Colour", key: "colour", inputType: "dropdown", section: "Colours" },

  // Optical section
  { name: "Beam Angle (°)", key: "beamAngle", inputType: "dropdown", section: "Optical" },
  { name: "Colour Temp", key: "colourTemp", inputType: "dropdown", section: "Optical" },

  // Dimensions section
  { name: "Diameter (mm)", key: "diameter", inputType: "number", section: "Dimensions" },
  { name: "Height (mm)", key: "height", inputType: "number", section: "Dimensions" },
  { name: "Width (mm)", key: "width", inputType: "number", section: "Dimensions" },
  { name: "Depth (mm)", key: "depth", inputType: "number", section: "Dimensions" },
  { name: "Cutout Size (mm)", key: "cutoutSize", inputType: "number", section: "Dimensions" },

  // Materials section
  { name: "Material", key: "material", inputType: "dropdown", section: "Materials" },

  // Technical section
  { name: "Mounting", key: "mounting", inputType: "dropdown", section: "Technical" },
  { name: "IP Rating", key: "ipRating", inputType: "dropdown", section: "Technical" },
  { name: "Globe Type", key: "globeType", inputType: "dropdown", section: "Technical" },
  { name: "Dimmable", key: "dimmable", inputType: "dropdown", section: "Technical" },
  { name: "Low Voltage Options", key: "lowVoltageOptions", inputType: "text", section: "Technical" },
];

export const defaultLegalValues: LegalValue[] = [
  // Colour
  { propertyName: "Colour", allowedValue: "White" },
  { propertyName: "Colour", allowedValue: "Black" },
  { propertyName: "Colour", allowedValue: "Silver" },
  { propertyName: "Colour", allowedValue: "Gold" },
  { propertyName: "Colour", allowedValue: "Bronze" },
  { propertyName: "Colour", allowedValue: "Copper" },
  { propertyName: "Colour", allowedValue: "Chrome" },
  { propertyName: "Colour", allowedValue: "Nickel" },
  { propertyName: "Colour", allowedValue: "Brass" },
  { propertyName: "Colour", allowedValue: "Natural" },
  { propertyName: "Colour", allowedValue: "Clear" },
  { propertyName: "Colour", allowedValue: "Frosted" },

  // Beam Angle
  { propertyName: "Beam Angle (°)", allowedValue: "15°" },
  { propertyName: "Beam Angle (°)", allowedValue: "24°" },
  { propertyName: "Beam Angle (°)", allowedValue: "36°" },
  { propertyName: "Beam Angle (°)", allowedValue: "45°" },
  { propertyName: "Beam Angle (°)", allowedValue: "60°" },
  { propertyName: "Beam Angle (°)", allowedValue: "90°" },
  { propertyName: "Beam Angle (°)", allowedValue: "120°" },
  { propertyName: "Beam Angle (°)", allowedValue: "360°" },

  // Colour Temp
  { propertyName: "Colour Temp", allowedValue: "2700K" },
  { propertyName: "Colour Temp", allowedValue: "3000K" },
  { propertyName: "Colour Temp", allowedValue: "4000K" },
  { propertyName: "Colour Temp", allowedValue: "5000K" },
  { propertyName: "Colour Temp", allowedValue: "6000K" },
  { propertyName: "Colour Temp", allowedValue: "RGB" },
  { propertyName: "Colour Temp", allowedValue: "Tunable White" },

  // Material
  { propertyName: "Material", allowedValue: "Aluminium" },
  { propertyName: "Material", allowedValue: "Steel" },
  { propertyName: "Material", allowedValue: "Stainless Steel" },
  { propertyName: "Material", allowedValue: "Plastic" },
  { propertyName: "Material", allowedValue: "Glass" },
  { propertyName: "Material", allowedValue: "Acrylic" },
  { propertyName: "Material", allowedValue: "Wood" },
  { propertyName: "Material", allowedValue: "Fabric" },
  { propertyName: "Material", allowedValue: "Ceramic" },
  { propertyName: "Material", allowedValue: "Concrete" },

  // Mounting
  { propertyName: "Mounting", allowedValue: "Surface Mount" },
  { propertyName: "Mounting", allowedValue: "Recessed" },
  { propertyName: "Mounting", allowedValue: "Pendant" },
  { propertyName: "Mounting", allowedValue: "Track" },
  { propertyName: "Mounting", allowedValue: "Wall Mount" },
  { propertyName: "Mounting", allowedValue: "Pole Mount" },
  { propertyName: "Mounting", allowedValue: "Ground Spike" },
  { propertyName: "Mounting", allowedValue: "Flush Mount" },

  // IP Rating
  { propertyName: "IP Rating", allowedValue: "IP20" },
  { propertyName: "IP Rating", allowedValue: "IP44" },
  { propertyName: "IP Rating", allowedValue: "IP54" },
  { propertyName: "IP Rating", allowedValue: "IP65" },
  { propertyName: "IP Rating", allowedValue: "IP66" },
  { propertyName: "IP Rating", allowedValue: "IP67" },
  { propertyName: "IP Rating", allowedValue: "IP68" },

  // Globe Type
  { propertyName: "Globe Type", allowedValue: "E27" },
  { propertyName: "Globe Type", allowedValue: "E14" },
  { propertyName: "Globe Type", allowedValue: "GU10" },
  { propertyName: "Globe Type", allowedValue: "GU5.3" },
  { propertyName: "Globe Type", allowedValue: "G9" },
  { propertyName: "Globe Type", allowedValue: "G4" },
  { propertyName: "Globe Type", allowedValue: "B22" },
  { propertyName: "Globe Type", allowedValue: "Integrated LED" },

  // Dimmable
  { propertyName: "Dimmable", allowedValue: "Yes" },
  { propertyName: "Dimmable", allowedValue: "No" },
  { propertyName: "Dimmable", allowedValue: "Trailing Edge" },
  { propertyName: "Dimmable", allowedValue: "Leading Edge" },
  { propertyName: "Dimmable", allowedValue: "0-10V" },
  { propertyName: "Dimmable", allowedValue: "DALI" },
];
