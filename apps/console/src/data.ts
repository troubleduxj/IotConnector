import { Tag, Recipe, HistoricalDataPoint } from './types';

export const mockTags: Tag[] = [
  // Siemens Profinet (S7-1500)
  { id: '1', channel: 'R0021_S7_1500', name: 'R0021.pH', value: 7.2, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '2', channel: 'R0021_S7_1500', name: 'R0021.Temperature', value: 35.5, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '3', channel: 'R0021_S7_1500', name: 'R0021.Pressure', value: 1.2, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '4', channel: 'R0021_S7_1500', name: 'R0021.alm1', value: false, type: 'boolean', quality: 'Good', lastUpdated: new Date().toISOString() },
  
  // Modbus TCP (Drive & Inverter)
  { id: '5', channel: 'R0022_Modbus_Drive', name: 'R0022.Speed', value: 1200, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '6', channel: 'R0022_Modbus_Drive', name: 'R0022.Status', value: 'Running', type: 'string', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '7', channel: 'R0022_Modbus_Drive', name: 'R0022.Current', value: 24.8, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },

  // OPC UA
  { id: '8', channel: 'OPC_UA_Server', name: 'Main.Pressure', value: 4.8, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '9', channel: 'OPC_UA_Server', name: 'Main.FlowRate', value: 125.4, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },

  // EtherNet/IP (Rockwell ControlLogix)
  { id: '10', channel: 'AB_ControlLogix_Line1', name: 'Line1.ConveyorSpeed', value: 3.2, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '11', channel: 'AB_ControlLogix_Line1', name: 'Line1.PartCount', value: 3930, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '12', channel: 'AB_ControlLogix_Line1', name: 'Line1.EStop', value: true, type: 'boolean', quality: 'Good', lastUpdated: new Date().toISOString() },

  // Mitsubishi MELSEC (iQ-F FX5U)
  { id: '13', channel: 'Mitsu_FX5U_Packer', name: 'Packer.SealTemp', value: 185.0, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '14', channel: 'Mitsu_FX5U_Packer', name: 'Packer.ReadyFlag', value: true, type: 'boolean', quality: 'Good', lastUpdated: new Date().toISOString() },

  // Omron FINS (CJ2)
  { id: '15', channel: 'Omron_CJ2_Welder', name: 'Welder.Voltage', value: 22.4, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '16', channel: 'Omron_CJ2_Welder', name: 'Welder.ArcOK', value: true, type: 'boolean', quality: 'Good', lastUpdated: new Date().toISOString() },

  // MQTT / Sparkplug B
  { id: '17', channel: 'Sparkplug_Edge_Node', name: 'Robot.Joint1_Torque', value: 42.6, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '18', channel: 'Sparkplug_Edge_Node', name: 'Robot.CycleProgress', value: 78, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },

  // BACnet/IP
  { id: '19', channel: 'HVAC_Building_Chiller', name: 'Chiller.ChilledWaterSupplyTemp', value: 6.8, type: 'number', quality: 'Good', lastUpdated: new Date().toISOString() },
  { id: '20', channel: 'HVAC_Building_Chiller', name: 'Chiller.CompressorStatus', value: true, type: 'boolean', quality: 'Good', lastUpdated: new Date().toISOString() },
];

export const mockRecipes: Recipe[] = [
  {
    id: 'r1',
    name: 'Polypeptide Recipe',
    description: 'Standard recipe for polypeptide production',
    enabled: true,
    parameters: [
      { name: 'Target_pH', defaultValue: 7.0, type: 'number' },
      { name: 'Target_Temp', defaultValue: 36.0, type: 'number' },
      { name: 'Mixing_Speed', defaultValue: 1500, type: 'number' },
    ]
  },
  {
    id: 'r2',
    name: 'Cleaning Recipe',
    description: 'CIP (Clean-in-Place) automated sequence',
    enabled: false,
    parameters: [
      { name: 'Water_Temp', defaultValue: 85.0, type: 'number' },
      { name: 'Acid_Concentration', defaultValue: 1.5, type: 'number' },
    ]
  }
];

export const generateHistoricalData = (tagName: string): HistoricalDataPoint[] => {
  const data: HistoricalDataPoint[] = [];
  const now = new Date();
  let baseValue = tagName.includes('pH') 
    ? 7.0 
    : tagName.includes('Temperature') || tagName.includes('Temp')
    ? 35.0 
    : tagName.includes('Speed')
    ? 1200
    : tagName.includes('Torque')
    ? 42
    : 100;
  
  for (let i = 60; i >= 0; i--) {
    const time = new Date(now.getTime() - i * 60000);
    const randomVariation = (Math.random() - 0.5) * (baseValue * 0.05);
    data.push({
      timestamp: time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      value: Number((baseValue + randomVariation).toFixed(2))
    });
  }
  return data;
};
