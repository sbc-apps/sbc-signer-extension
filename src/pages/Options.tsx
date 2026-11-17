/**
 * Options page — full-tab settings for the extension.
 *
 * Layout:
 *  - Header with product branding
 *  - Per-site permissions (expanded)
 *  - Logged-out prompt when no account is active
 *  - Footer with the extension version
 */

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Card, CardContent } from '@/components/ui/card';
import { LoginArea } from '@/components/auth/LoginArea';
import { Logo } from '@/components/Logo';
import { EsploraSettings } from '@/components/EsploraSettings';
import { PrivacySettings } from '@/components/PrivacySettings';
import { RelaySettings } from '@/components/RelaySettings';
import { SitePermissionsList } from '@/components/SitePermissionsList';
import { TabsHeader } from '@/components/TabsHeader';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';

export function Options() {
  useDocumentTitle('Settings');
  const { currentUser } = useLoggedInAccounts();

  return (
    <div className="min-h-screen bg-page">
      <TabsHeader />

      {/*
        Center column with a translucent card so the user's profile
        background image (when set) is visible around the edges of the
        page while the actual settings content remains legible on top.
        Without a bg image, --background is solid and the column reads
        as a slightly lifted surface against the muted page bg.
      */}
      <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        {!currentUser && (
          <div className="bg-background/85 backdrop-blur border rounded-xl shadow-sm px-6 py-6">
            <LoggedOutCard />
          </div>
        )}

        <section className="bg-background/85 backdrop-blur border rounded-xl shadow-sm px-6 py-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">Connected sites</h2>
              <p className="text-sm text-muted-foreground">
                Every site you've allowed or blocked is listed here. Remove a site to force it to ask again.
              </p>
            </div>
          </div>
          <SitePermissionsList />
        </section>

        <section className="bg-background/85 backdrop-blur border rounded-xl shadow-sm px-6 py-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">Settings</h2>
            </div>
          </div>
          <div className="space-y-3">
            <Accordion type="multiple" className="space-y-3">
              <AccordionItem
                value="relays"
                className="border rounded-lg px-4 last:border-b"
              >
                <AccordionTrigger>Relays</AccordionTrigger>
                <AccordionContent>
                  <RelaySettings />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem
                value="bitcoin-apis"
                className="border rounded-lg px-4 last:border-b"
              >
                <AccordionTrigger>Bitcoin APIs</AccordionTrigger>
                <AccordionContent>
                  <EsploraSettings />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            <div className="rounded-lg border px-4">
              <PrivacySettings />
            </div>
          </div>
        </section>

        <footer className="flex justify-center">
          <span className="rounded-full border bg-background/85 backdrop-blur px-3 py-1 text-xs text-muted-foreground">
            SBC Signer Extension v{__APP_VERSION__}
          </span>
        </footer>
      </main>
    </div>
  );
}

function LoggedOutCard() {
  return (
    <Card>
      <CardContent className="py-8 px-6 flex flex-col items-center text-center gap-3">
        <Logo className="size-14" alt="SBC Signer" />
        <p className="text-sm text-muted-foreground max-w-sm">
          Log in to start using SBC Signer Extension. Your account lives in this extension; sites see
          your public key and signed events, but never your secret key.
        </p>
        <LoginArea className="w-64" />
      </CardContent>
    </Card>
  );
}

export default Options;
