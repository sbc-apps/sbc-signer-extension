import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { Accounts } from './Accounts';

const { setLogin, refetch } = vi.hoisted(() => ({ setLogin: vi.fn(), refetch: vi.fn() }));
const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
vi.mock('@/components/TabsHeader', () => ({ TabsHeader: () => null }));
vi.mock('@/components/auth/LoginArea', () => ({ LoginArea: () => null }));
vi.mock('@/hooks/useLoggedInAccounts', () => ({ useLoggedInAccounts: () => ({
  authors: [{ id: 'a', pubkey: first, metadata: { name: 'Alice' } }, { id: 'b', pubkey: second, metadata: { name: 'Bob' } }],
  currentUser: { id: 'a', pubkey: first }, setLogin,
}) }));
vi.mock('@nostrify/react/login', () => ({ useNostrLogin: () => ({ logins: [{ id: 'b', type: 'nsec', secret: 'PRIVATE_TEST_SECRET' }] }) }));
vi.mock('@/hooks/useAuthor', () => ({ useAuthor: () => ({
  data: { metadata: { name: 'Bob', about: 'Hello from Bob', picture: 'javascript:alert(1)', banner: 'data:text/html,test', website: 'javascript:alert(1)', nip05: 'bob@example.com', lud16: 'bob@lightning.example' }, event: { created_at: 1, content: '{"name":"Bob","custom":"public field"}' } },
  isLoading: false, isFetching: false, isError: false, refetch,
}) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows another account without switching and rejects unsafe metadata URLs', () => {
  const { container } = render(<MemoryRouter initialEntries={[`/accounts/${second}`]}><Routes><Route path="/accounts/:pubkey" element={<Accounts />} /></Routes></MemoryRouter>);
  expect(screen.getByText('Hello from Bob')).toBeInTheDocument();
  expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  expect(screen.getByText(second)).toBeInTheDocument();
  expect(screen.getByText('Local signer')).toBeInTheDocument();
  expect(screen.getByText(/public field/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use this account' })).toBeInTheDocument();
  expect(setLogin).not.toHaveBeenCalled();
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(container.textContent).not.toContain('PRIVATE_TEST_SECRET');
});

it('handles a profile for an account that is no longer signed in', () => {
  render(<MemoryRouter initialEntries={['/accounts/missing']}><Routes><Route path="/accounts/:pubkey" element={<Accounts />} /></Routes></MemoryRouter>);
  expect(screen.getByRole('status')).toHaveTextContent('no longer signed in');
  expect(screen.queryByRole('button', { name: 'Use this account' })).toBeNull();
});
