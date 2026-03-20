// Category hierarchy data structure

export interface CategoryLevel {
  name: string;
  children?: CategoryLevel[];
}

export const categoryTree: CategoryLevel[] = [
  {
    name: "Indoor Lights",
    children: [
      {
        name: "Ceiling Lights",
        children: [
          { name: "Ceiling Spotlights" },
          { name: "Downlights" },
          { name: "Panel Lights" },
          { name: "Chandeliers" },
          { name: "Pendant Lights" },
          { name: "Flush Mounts" },
        ],
      },
      {
        name: "Wall Lights",
        children: [
          { name: "Wall Sconces" },
          { name: "Picture Lights" },
          { name: "Up/Down Lights" },
        ],
      },
      {
        name: "Floor Lamps",
        children: [
          { name: "Standing Lamps" },
          { name: "Arc Lamps" },
          { name: "Tripod Lamps" },
        ],
      },
      {
        name: "Table Lamps",
        children: [
          { name: "Desk Lamps" },
          { name: "Bedside Lamps" },
          { name: "Accent Lamps" },
        ],
      },
      { name: "Track Lighting" },
      { name: "Recessed Lighting" },
    ],
  },
  {
    name: "Outdoor Lights",
    children: [
      {
        name: "Garden Lights",
        children: [
          { name: "Path Lights" },
          { name: "Bollard Lights" },
          { name: "Spike Lights" },
          { name: "In-Ground Lights" },
        ],
      },
      {
        name: "Wall Lights",
        children: [
          { name: "Security Lights" },
          { name: "Porch Lights" },
          { name: "Step Lights" },
        ],
      },
      { name: "Flood Lights" },
      { name: "Post Lights" },
      { name: "String Lights" },
    ],
  },
  {
    name: "Commercial Lights",
    children: [
      {
        name: "Office Lighting",
        children: [
          { name: "Troffer Panels" },
          { name: "Linear Lights" },
          { name: "Task Lights" },
        ],
      },
      {
        name: "Retail Lighting",
        children: [
          { name: "Track Spotlights" },
          { name: "Display Lights" },
          { name: "Accent Lighting" },
        ],
      },
      {
        name: "Industrial Lighting",
        children: [
          { name: "High Bay Lights" },
          { name: "Low Bay Lights" },
          { name: "Warehouse Lights" },
        ],
      },
      { name: "Emergency Lighting" },
      { name: "Exit Signs" },
    ],
  },
  {
    name: "Decorative Lights",
    children: [
      {
        name: "LED Strip Lights",
        children: [
          { name: "RGB Strips" },
          { name: "Single Color Strips" },
          { name: "Smart Strips" },
        ],
      },
      { name: "Neon Signs" },
      { name: "Fairy Lights" },
      { name: "Novelty Lights" },
    ],
  },
  {
    name: "Smart Lighting",
    children: [
      {
        name: "Smart Bulbs",
        children: [
          { name: "WiFi Bulbs" },
          { name: "Zigbee Bulbs" },
          { name: "Bluetooth Bulbs" },
        ],
      },
      { name: "Smart Switches" },
      { name: "Smart Dimmers" },
      { name: "Smart Controllers" },
    ],
  },
  {
    name: "Bulbs & Globes",
    children: [
      {
        name: "LED Bulbs",
        children: [
          { name: "A-Shape" },
          { name: "Globe" },
          { name: "Candle" },
          { name: "Tube" },
          { name: "Reflector" },
        ],
      },
      {
        name: "Specialty Bulbs",
        children: [
          { name: "Vintage/Edison" },
          { name: "Coloured" },
          { name: "Dimmable" },
        ],
      },
      { name: "Halogen" },
      { name: "CFL" },
    ],
  },
  {
    name: "Accessories",
    children: [
      { name: "Drivers & Transformers" },
      { name: "Mounting Hardware" },
      { name: "Cables & Connectors" },
      { name: "Dimmers & Controls" },
    ],
  },
];

// Check if a node is a leaf (no children)
export function isLeaf(node: CategoryLevel): boolean {
  return !node.children || node.children.length === 0;
}

// Build full path for all leaves in the tree
export interface LeafPath {
  path: string;
  segments: string[];
}

export function getAllLeafPaths(tree: CategoryLevel[], prefix: string[] = []): LeafPath[] {
  const results: LeafPath[] = [];
  for (const node of tree) {
    const segments = [...prefix, node.name];
    if (isLeaf(node)) {
      results.push({ path: segments.join("/"), segments });
    } else if (node.children) {
      results.push(...getAllLeafPaths(node.children, segments));
    }
  }
  return results;
}

// Filter tree nodes by search query — keeps parents if any descendant leaf matches
export function filterTree(tree: CategoryLevel[], query: string): CategoryLevel[] {
  const lower = query.toLowerCase();
  return tree
    .map((node) => {
      if (isLeaf(node)) {
        return node.name.toLowerCase().includes(lower) ? node : null;
      }
      const filteredChildren = filterTree(node.children!, lower);
      if (filteredChildren.length > 0) {
        return { ...node, children: filteredChildren };
      }
      return node.name.toLowerCase().includes(lower) ? { ...node } : null;
    })
    .filter(Boolean) as CategoryLevel[];
}
