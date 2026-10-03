import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // `bg-muted` is the right token for a low-attention placeholder
      // surface — a desaturated tint of the background. shadcn's
      // default of `bg-accent` works too now that --accent is mapped
      // to a subtle surface (matching --secondary), but bg-muted
      // expresses the intent ("this is filler, not a hover target")
      // more clearly.
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton }
