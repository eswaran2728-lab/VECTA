import Link from "next/link";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent } from "@/components/icms/ui/card";

export default function VendorTransactionNotFound() {
  return (
    <div className="mx-auto max-w-lg py-16">
      <Card>
        <CardContent className="space-y-3 pt-6 text-center">
          <h1 className="text-lg font-semibold">Delivery not found</h1>
          <p className="text-sm text-muted-foreground">
            This vendor delivery doesn&apos;t exist, or you don&apos;t have visibility into it
            from your current role. If you believe this is a mistake, check with your
            supervisor or Management.
          </p>
          <Link href="/icms/vendor-transactions">
            <Button className="mt-2">Back to Deliveries</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
