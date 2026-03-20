import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchBrandsWithSource, type BrandFetchResult } from "@/lib/api";

const Brands = () => {
  const { data: brandsResult, isLoading } = useQuery<BrandFetchResult>({
    queryKey: ["brands-with-source"],
    queryFn: fetchBrandsWithSource,
    staleTime: 60_000,
    retry: 2,
  });

  const brands = useMemo(() => brandsResult?.brands ?? [], [brandsResult]);

  return (
    <div className="p-4">
      <div className="bg-card border border-border rounded-lg shadow-sm">
        {isLoading ? (
          <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-b border-border">
                <TableHead className="text-xs font-semibold w-[30%]">Brand</TableHead>
                <TableHead className="text-xs font-semibold w-[35%]">Brand Name</TableHead>
                <TableHead className="text-xs font-semibold w-[35%]">Website</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {brands.map((entry, i) => (
                <TableRow key={i} className="hover:bg-muted/40 transition-colors">
                  <TableCell className="text-xs font-medium">{entry.brand}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{entry.brandName}</TableCell>
                  <TableCell className="text-xs text-primary hover:underline">
                    {entry.website ? (
                      <a href={entry.website} target="_blank" rel="noopener noreferrer">
                        {entry.website}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {brands.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-8">
                    No brands yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
};

export default Brands;
