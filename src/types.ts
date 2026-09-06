export interface Tag {
  id: string;
  name: string;
  value: string | number | boolean;
  type: 'number' | 'string' | 'boolean';
  channel: string;
  quality: 'Good' | 'Bad' | 'Uncertain';
  lastUpdated: string;
}

export interface RecipeParameter {
  name: string;
  defaultValue: string | number;
  type: 'number' | 'string';
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  parameters: RecipeParameter[];
}

export interface HistoricalDataPoint {
  timestamp: string;
  value: number;
}
