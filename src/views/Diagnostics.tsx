import React, { useState } from 'react';
import { mockTags } from '../data';
import { Search, Send, Edit2, X } from 'lucide-react';
import { Tag } from '../types';

export default function Diagnostics() {
  const [searchTerm, setSearchTerm] = useState('');
  const [tags, setTags] = useState<Tag[]>(mockTags);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [editValue, setEditValue] = useState<string>('');

  const filteredTags = tags.filter(tag => 
    tag.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    tag.channel.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleEdit = (tag: Tag) => {
    setEditingTag(tag);
    setEditValue(String(tag.value));
  };

  const handleSave = () => {
    if (!editingTag) return;
    
    let parsedValue: string | number | boolean = editValue;
    if (editingTag.type === 'number') {
      parsedValue = Number(editValue) || 0;
    } else if (editingTag.type === 'boolean') {
      parsedValue = editValue.toLowerCase() === 'true';
    }

    setTags(tags.map(t => t.id === editingTag.id ? { ...t, value: parsedValue, lastUpdated: new Date().toISOString() } : t));
    setEditingTag(null);
  };

  return (
    <div className="space-y-6 relative">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
          <div className="relative w-72">
            <Search className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
            <input 
              type="text"
              placeholder="Filter by TagName or Channel..."
              className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-[11px] uppercase font-bold tracking-wider">
                <th className="px-6 py-3 border-b border-slate-200">Channel</th>
                <th className="px-6 py-3 border-b border-slate-200">TagName</th>
                <th className="px-6 py-3 border-b border-slate-200">Value</th>
                <th className="px-6 py-3 border-b border-slate-200">Type</th>
                <th className="px-6 py-3 border-b border-slate-200">Quality</th>
                <th className="px-6 py-3 border-b border-slate-200 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="text-sm text-slate-600">
              {filteredTags.map(tag => (
                <tr key={tag.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors group">
                  <td className="px-6 py-4 font-mono font-medium">{tag.channel}</td>
                  <td className="px-6 py-4 font-mono font-medium text-slate-900">{tag.name}</td>
                  <td className="px-6 py-4 font-semibold text-slate-700">
                    {typeof tag.value === 'boolean' ? (tag.value ? 'True' : 'False') : tag.value}
                  </td>
                  <td className="px-6 py-4 text-slate-500">{tag.type}</td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center gap-2 font-medium ${
                      tag.quality === 'Good' ? 'text-green-700' : 'text-amber-700'
                    }`}>
                      <span className={`w-2 h-2 rounded-full ${tag.quality === 'Good' ? 'bg-green-500' : 'bg-amber-500'}`}></span>
                      {tag.quality}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button 
                      onClick={() => handleEdit(tag)}
                      className="text-slate-400 hover:text-indigo-600 transition-colors p-1 rounded-md hover:bg-indigo-50"
                      title="Write Value"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {filteredTags.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500 text-sm">
                    No tags found matching "{searchTerm}"
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Modal */}
      {editingTag && (
        <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center">
              <h3 className="font-semibold text-slate-800">Write Tag Value</h3>
              <button onClick={() => setEditingTag(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Tag Name</label>
                <div className="text-sm font-medium text-slate-900">{editingTag.name}</div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Current Value</label>
                <div className="text-sm text-slate-700">{String(editingTag.value)}</div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">New Value</label>
                <input 
                  type="text" 
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  autoFocus
                />
              </div>
            </div>
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end space-x-3">
              <button 
                onClick={() => setEditingTag(null)}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-md transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleSave}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md transition-colors flex items-center"
              >
                <Send className="w-4 h-4 mr-2" />
                Send to Controller
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
