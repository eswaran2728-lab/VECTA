import Link from "next/link";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent } from "@/components/icms/ui/card";

export default function TransactionNotFound() {
  return (
    <div className="mx-auto max-w-lg py-16">
      <Card>
        <CardContent className="space-y-3 pt-6 text-center">
          <h1 className="text-lg font-semibold">Transaction not found</h1>
          <p className="text-sm text-muted-foreground">
            This transaction doesn&apos;t exist, or you don&apos;t have visibility into it from
            your current role/branch. If you believe this is a mistake, check with your
            supervisor or Management.
          </p>
          <Link href="/icms/transactions">
            <Button className="mt-2">Back to Transactions</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
