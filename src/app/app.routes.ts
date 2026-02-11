import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home/home').then(m => m.Home),
  },
  {
    path: 'hamming',
    loadComponent: () => import('./pages/hamming/hamming').then(m => m.Hamming),
  },
  {
    path: 'reed-solomon',
    loadComponent: () => import('./pages/reed-solomon/reed-solomon').then(m => m.ReedSolomon),
  },
  {
    path: 'ldpc',
    loadComponent: () => import('./pages/ldpc/ldpc').then(m => m.Ldpc),
  },
  {
    path: 'polar',
    loadComponent: () => import('./pages/polar/polar').then(m => m.Polar),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
