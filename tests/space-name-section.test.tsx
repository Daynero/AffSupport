// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamApiError } from '../apps/web/src/api/team';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider, useTeam } from '../apps/web/src/team/TeamContext';
import { SpaceNameSection } from '../apps/web/src/team/workspace/SpaceNameSection';
import { makeTeam } from './team-space-fixtures';

/** A space can be renamed from its settings (024). */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const team = makeTeam();

function Heading() {
  const { teams } = useTeam();
  return <h1>{teams[0]?.name}</h1>;
}

function renderSection(renameTeam: (teamId: string, name: string) => Promise<string>) {
  render(
    <TeamProvider initialTeams={[team]} realtime={false}>
      <ToastProvider>
        <Heading />
        <SpaceNameSection teamId={team.id} client={{ renameTeam }} />
      </ToastProvider>
    </TeamProvider>
  );
}

describe('renaming a space', () => {
  it('saves a new name and shows it everywhere the space is named', async () => {
    const renameTeam = vi.fn().mockResolvedValue('Nutra PL');
    renderSection(renameTeam);
    const field = screen.getByLabelText('Space name');
    expect(screen.getByRole('button', { name: 'Save name' })).toHaveProperty('disabled', true);
    fireEvent.change(field, { target: { value: '  Nutra   PL ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(renameTeam).toHaveBeenCalledWith(team.id, 'Nutra PL'));
    expect(await screen.findByRole('heading', { name: 'Nutra PL' })).toBeTruthy();
  });

  it('says so when another of your spaces has the name', async () => {
    renderSection(vi.fn().mockRejectedValue(new TeamApiError('NAME_CONFLICT', false)));
    fireEvent.change(screen.getByLabelText('Space name'), { target: { value: 'Other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('You already belong to a space with this name.')).toBeTruthy();
  });
});
