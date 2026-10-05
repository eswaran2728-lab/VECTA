export function ModuleNotActivated({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="space-y-4" data-testid="module-not-activated">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Not activated</p>
        <p>{detail}</p>
      </div>
    </div>
  );
}
