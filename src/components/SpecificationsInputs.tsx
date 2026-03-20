import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface Specifications {
  colour1: string;
  colour2: string;
  beamAngle: string;
  colourTemp: string;
  diameter: string;
  height: string;
  width: string;
  cutoutSize: string;
  depth: string;
  material1: string;
  material2: string;
  mounting: string;
  ipRating: string;
  globeType: string;
  dimmable: string;
  lowVoltageOptions: string;
}

interface SpecificationsInputsProps {
  specs: Specifications;
  onSpecChange: (field: keyof Specifications, value: string) => void;
}

const colourOptions = ["", "White", "Black", "Silver", "Gold", "Bronze", "Copper", "Chrome", "Nickel", "Brass", "Natural", "Clear", "Frosted"];
const mountingOptions = ["", "Surface Mount", "Recessed", "Pendant", "Track", "Wall Mount", "Pole Mount", "Ground Spike", "Flush Mount"];
const ipRatingOptions = ["", "IP20", "IP44", "IP54", "IP65", "IP66", "IP67", "IP68"];
const globeTypeOptions = ["", "E27", "E14", "GU10", "GU5.3", "G9", "G4", "B22", "Integrated LED"];
const dimmableOptions = ["", "Yes", "No", "Trailing Edge", "Leading Edge", "0-10V", "DALI"];
const beamAngleOptions = ["", "15°", "24°", "36°", "45°", "60°", "90°", "120°", "360°"];
const colourTempOptions = ["", "2700K", "3000K", "4000K", "5000K", "6000K", "RGB", "Tunable White"];
const materialOptions = ["", "Aluminium", "Steel", "Stainless Steel", "Plastic", "Glass", "Acrylic", "Wood", "Fabric", "Ceramic", "Concrete"];

export function SpecificationsInputs({ specs, onSpecChange }: SpecificationsInputsProps) {
  return (
    <div className="space-y-4">
      {/* Colours */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Colour #1</Label>
          <Select value={specs.colour1} onValueChange={(v) => onSpecChange("colour1", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {colourOptions.map((opt) => (
                <SelectItem key={opt || "empty"} value={opt || "none"}>{opt || "None"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Colour #2</Label>
          <Select value={specs.colour2} onValueChange={(v) => onSpecChange("colour2", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {colourOptions.map((opt) => (
                <SelectItem key={opt || "empty"} value={opt || "none"}>{opt || "None"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Beam Angle</Label>
          <Select value={specs.beamAngle} onValueChange={(v) => onSpecChange("beamAngle", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {beamAngleOptions.map((opt) => (
                <SelectItem key={opt || "empty"} value={opt || "none"}>{opt || "None"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Colour Temp</Label>
          <Select value={specs.colourTemp} onValueChange={(v) => onSpecChange("colourTemp", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {colourTempOptions.map((opt) => (
                <SelectItem key={opt || "empty"} value={opt || "none"}>{opt || "None"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Dimensions */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Diameter (mm)</Label>
          <Input
            value={specs.diameter}
            onChange={(e) => onSpecChange("diameter", e.target.value)}
            placeholder="e.g. 100"
            className="h-9 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Height (mm)</Label>
          <Input
            value={specs.height}
            onChange={(e) => onSpecChange("height", e.target.value)}
            placeholder="e.g. 150"
            className="h-9 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Width (mm)</Label>
          <Input
            value={specs.width}
            onChange={(e) => onSpecChange("width", e.target.value)}
            placeholder="e.g. 200"
            className="h-9 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Depth (mm)</Label>
          <Input
            value={specs.depth}
            onChange={(e) => onSpecChange("depth", e.target.value)}
            placeholder="e.g. 50"
            className="h-9 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Cutout Size (mm)</Label>
          <Input
            value={specs.cutoutSize}
            onChange={(e) => onSpecChange("cutoutSize", e.target.value)}
            placeholder="e.g. 90"
            className="h-9 text-sm"
          />
        </div>
      </div>

      {/* Materials & Other */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Material #1</Label>
          <Select value={specs.material1} onValueChange={(v) => onSpecChange("material1", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {materialOptions.map((opt) => (
                <SelectItem key={opt || "empty"} value={opt || "none"}>{opt || "None"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Material #2</Label>
          <Select value={specs.material2} onValueChange={(v) => onSpecChange("material2", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {materialOptions.map((opt) => (
                <SelectItem key={opt || "empty"} value={opt || "none"}>{opt || "None"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Mounting</Label>
          <Select value={specs.mounting} onValueChange={(v) => onSpecChange("mounting", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {mountingOptions.map((opt) => (
                <SelectItem key={opt || "empty"} value={opt || "none"}>{opt || "None"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">IP Rating</Label>
          <Select value={specs.ipRating} onValueChange={(v) => onSpecChange("ipRating", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {ipRatingOptions.map((opt) => (
                <SelectItem key={opt || "empty"} value={opt || "none"}>{opt || "None"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Globe & Dimming */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Globe Type</Label>
          <Select value={specs.globeType} onValueChange={(v) => onSpecChange("globeType", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {globeTypeOptions.map((opt) => (
                <SelectItem key={opt || "empty"} value={opt || "none"}>{opt || "None"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Dimmable</Label>
          <Select value={specs.dimmable} onValueChange={(v) => onSpecChange("dimmable", v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {dimmableOptions.map((opt) => (
                <SelectItem key={opt || "empty"} value={opt || "none"}>{opt || "None"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Low Voltage Options</Label>
          <Input
            value={specs.lowVoltageOptions}
            onChange={(e) => onSpecChange("lowVoltageOptions", e.target.value)}
            placeholder="e.g. 12V, 24V"
            className="h-9 text-sm"
          />
        </div>
      </div>
    </div>
  );
}
