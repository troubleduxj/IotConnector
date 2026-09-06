import React, { useState } from 'react';
import { mockRecipes } from '../data';
import { Download, Plus, Settings2, Trash2 } from 'lucide-react';
import { Recipe } from '../types';

export default function Recipes() {
  const [recipes, setRecipes] = useState<Recipe[]>(mockRecipes);

  const handleDownload = (recipe: Recipe) => {
    alert(`Downloading recipe: ${recipe.name} to controller...`);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <p className="text-sm text-slate-500">Manage and download recipe parameters to the equipment.</p>
        <button className="flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors">
          <Plus className="w-4 h-4 mr-2" />
          Add Recipe
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {recipes.map(recipe => (
          <div key={recipe.id} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-slate-800 text-lg">{recipe.name}</h3>
                <p className="text-sm text-slate-500 mt-1">{recipe.description}</p>
              </div>
              <div className="flex items-center space-x-2">
                 <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${recipe.enabled ? 'bg-green-100 text-green-700 border-green-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                    {recipe.enabled ? 'Enabled' : 'Disabled'}
                 </span>
              </div>
            </div>
            
            <div className="p-6 flex-1">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Parameters</h4>
              <ul className="space-y-3">
                {recipe.parameters.map((param, idx) => (
                  <li key={idx} className="flex justify-between items-center py-2 border-b border-slate-100 last:border-0">
                    <span className="text-sm font-medium text-slate-700">{param.name}</span>
                    <span className="text-sm text-slate-600 bg-slate-100 px-3 py-1 rounded-md font-mono">{param.defaultValue}</span>
                  </li>
                ))}
              </ul>
            </div>
            
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end space-x-3">
               <button className="p-2 text-slate-400 hover:text-indigo-600 transition-colors rounded-md hover:bg-indigo-50" title="Settings">
                 <Settings2 className="w-4 h-4" />
               </button>
               <button className="p-2 text-slate-400 hover:text-red-600 transition-colors rounded-md hover:bg-red-50" title="Delete">
                 <Trash2 className="w-4 h-4" />
               </button>
               <div className="w-px h-8 bg-slate-200 mx-2"></div>
               <button 
                onClick={() => handleDownload(recipe)}
                className="flex items-center px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-md hover:bg-slate-700 transition-colors"
               >
                 <Download className="w-4 h-4 mr-2" />
                 Download
               </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
