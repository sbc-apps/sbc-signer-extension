import { Link, useParams } from 'react-router-dom';
import { nip19 } from 'nostr-tools';
import { useNostrLogin } from '@nostrify/react/login';
import { RefreshCw } from 'lucide-react';
import { TabsHeader } from '@/components/TabsHeader';
import { LoginArea } from '@/components/auth/LoginArea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { useAuthor } from '@/hooks/useAuthor';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { sanitizeUrl } from '@/lib/sanitizeUrl';
import { genUserName } from '@/lib/genUserName';

export function Accounts() {
  useDocumentTitle('Accounts');
  const { pubkey } = useParams();
  const { authors, currentUser, setLogin } = useLoggedInAccounts();
  const { logins } = useNostrLogin();
  const account = pubkey ? authors.find((entry) => entry.pubkey === pubkey) : currentUser;
  const profile = useAuthor(account?.pubkey);
  const metadata = profile.data?.metadata ?? account?.metadata ?? {};
  const name = metadata.display_name || metadata.name || (account ? genUserName(account.pubkey) : 'Accounts');
  const login = logins.find((entry) => entry.id === account?.id);
  const banner = sanitizeUrl(metadata.banner);
  const website = sanitizeUrl(metadata.website);

  return (
    <div className="min-h-screen bg-page">
      <TabsHeader />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Accounts</h1>
          <p className="text-sm text-muted-foreground mt-2">View the profiles and public information of your signed-in accounts.</p>
        </div>
        {authors.length === 0 ? (
          <section className="border border-dashed rounded-xl bg-background/85 p-8 text-center space-y-4">
            <p>Sign in to view your account profile.</p>
            <LoginArea />
          </section>
        ) : (
          <>
            <nav aria-label="Account profiles" className="grid sm:grid-cols-2 gap-3">
              {authors.map((entry) => {
                const label = entry.metadata.display_name || entry.metadata.name || genUserName(entry.pubkey);
                return (
                  <Link key={entry.id} to={`/accounts/${entry.pubkey}`} aria-current={entry.pubkey === account?.pubkey ? 'page' : undefined}
                    className="flex items-center gap-3 rounded-xl border bg-background/85 p-4 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:border-primary">
                    <Avatar><AvatarImage src={sanitizeUrl(entry.metadata.picture)} alt="" /><AvatarFallback>{label.charAt(0)}</AvatarFallback></Avatar>
                    <div className="min-w-0"><p className="font-medium truncate">{label}</p><p className="text-xs text-muted-foreground">{entry.id === currentUser?.id ? 'Active account' : 'Signed in'}</p></div>
                  </Link>
                );
              })}
            </nav>
            {!account ? <p role="status" className="border border-dashed rounded-xl p-6">This account is no longer signed in. Select an account above.</p> : (
              <section aria-label="Account profile" className="overflow-hidden rounded-xl border bg-background/95 shadow-sm">
                {banner && <img src={banner} alt="Profile banner" className="w-full h-40 object-cover" />}
                <div className="p-6 space-y-6">
                  <div className="flex flex-wrap items-center gap-4">
                    <Avatar className="size-20"><AvatarImage src={sanitizeUrl(metadata.picture)} alt={name} /><AvatarFallback>{name.charAt(0)}</AvatarFallback></Avatar>
                    <div className="flex-1 min-w-0"><h2 className="text-xl font-semibold break-words">{name}</h2>{metadata.name && <p className="text-muted-foreground break-words">@{metadata.name}</p>}</div>
                    <Button variant="outline" size="sm" disabled={profile.isFetching} onClick={() => void profile.refetch()}><RefreshCw className={profile.isFetching ? 'size-4 animate-spin' : 'size-4'} />Refresh</Button>
                  </div>
                  {profile.isLoading && <div aria-label="Loading profile" className="space-y-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-4 w-full" /></div>}
                  {profile.isError && <p role="status" className="text-sm text-muted-foreground">Profile metadata could not be loaded from your relays. Try refreshing.</p>}
                  {metadata.about && <p className="whitespace-pre-wrap break-words">{metadata.about}</p>}
                  {account.id !== currentUser?.id && <Button onClick={() => setLogin(account.id)}>Use this account</Button>}
                  <dl className="space-y-4 text-sm">
                    <Field label="Public key (npub)" value={nip19.npubEncode(account.pubkey)} />
                    <Field label="Public key (hex)" value={account.pubkey} />
                    <Field label="Login method" value={login?.type === 'nsec' ? 'Local signer' : login?.type === 'bunker' ? 'Remote signer (NIP-46)' : 'Browser extension'} />
                    <Field label="Nostr address (NIP-05)" value={metadata.nip05} />
                    <Field label="Lightning address" value={metadata.lud16} />
                    <Field label="Lightning LNURL" value={metadata.lud06} />
                    {website && <div><dt className="text-muted-foreground mb-1">Website</dt><dd><a className="text-primary underline break-all" href={website} target="_blank" rel="noopener noreferrer">{website}</a></dd></div>}
                    {metadata.bot !== undefined && <Field label="Automated account" value={metadata.bot ? 'Yes' : 'No'} />}
                    {profile.data?.event && <Field label="Profile updated" value={new Date(profile.data.event.created_at * 1000).toLocaleString()} />}
                  </dl>
                  {profile.data?.event && <details className="border-t pt-4"><summary className="cursor-pointer font-medium">All public profile metadata</summary><pre className="mt-4 text-xs whitespace-pre-wrap break-all rounded-lg bg-muted p-4">{profile.data.event.content}</pre></details>}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | undefined }) {
  return <div><dt className="text-muted-foreground mb-1">{label}</dt><dd className="break-all select-text">{value || 'Not provided'}</dd></div>;
}
