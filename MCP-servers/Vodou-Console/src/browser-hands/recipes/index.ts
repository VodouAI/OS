import type { Recipe } from '../recipe.js';
import { resyBookTable } from './resy-book-table.js';

/** Every first-party recipe. Add one here and it's offered to the model (tools.ts). */
export const RECIPES: Recipe[] = [resyBookTable];
