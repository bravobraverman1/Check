import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ImageUrlInputsProps {
  imageUrls: string[];
  onImageUrlChange: (index: number, value: string) => void;
  error?: string;
}

export function ImageUrlInputs({ imageUrls, onImageUrlChange, error }: ImageUrlInputsProps) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {imageUrls.map((url, index) => (
          <div key={index} className="space-y-1.5">
            <Label htmlFor={`image-${index}`} className="text-xs font-medium">
              Image URL {index + 1}{" "}
              {index === 0 && <span className="text-destructive">*</span>}
            </Label>
            <Input
              id={`image-${index}`}
              type="url"
              value={url}
              onChange={(e) => onImageUrlChange(index, e.target.value)}
              placeholder={index === 0 ? "https://example.com/image1.jpg (required)" : "https://example.com/image.jpg"}
              className="h-9 text-sm"
            />
          </div>
        ))}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
