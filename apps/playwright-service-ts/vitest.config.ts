/*
 * CamoCrawl — original rendering-service module.
 * Part of CamoCrawl (Firecrawl + Camoufox backend), licensed under the
 * GNU Affero General Public License v3.0 or later; see root LICENSE.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Do not remove this header or any upstream copyright/license notices.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
  },
});