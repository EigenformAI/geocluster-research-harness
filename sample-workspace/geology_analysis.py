#!/usr/bin/env python3
"""
Sample geology analysis script for Project Environment
Demonstrates basic geological data analysis capabilities in the Docker environment
"""

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime

def analyze_rock_samples():
    """Analyze geological rock sample data"""
    
    # Sample geological data
    samples = {
        'Sample_ID': ['RS001', 'RS002', 'RS003', 'RS004', 'RS005'],
        'Rock_Type': ['Granite', 'Basalt', 'Limestone', 'Sandstone', 'Shale'],
        'SiO2_percent': [72.5, 49.2, 5.1, 85.4, 58.3],
        'Al2O3_percent': [14.8, 15.7, 1.2, 8.9, 17.2],
        'Fe2O3_percent': [3.2, 12.4, 0.8, 2.1, 6.8],
        'CaO_percent': [1.8, 9.1, 53.4, 1.2, 2.4],
        'Location_Latitude': [45.123, 46.456, 44.789, 47.321, 45.987],
        'Location_Longitude': [-122.456, -123.789, -121.234, -124.567, -122.890]
    }
    
    df = pd.DataFrame(samples)
    
    print("🌍 Rock Sample Analysis")
    print("=" * 50)
    print(f"Analysis Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Total Samples: {len(df)}")
    print()
    
    print("Sample Overview:")
    print(df.to_string(index=False))
    print()
    
    # Basic statistics
    numeric_cols = ['SiO2_percent', 'Al2O3_percent', 'Fe2O3_percent', 'CaO_percent']
    print("Chemical Composition Statistics:")
    print(df[numeric_cols].describe())
    print()
    
    # Create visualization
    plt.figure(figsize=(12, 8))
    
    # Plot 1: SiO2 vs Al2O3 classification
    plt.subplot(2, 2, 1)
    colors = {'Granite': 'red', 'Basalt': 'blue', 'Limestone': 'green', 
              'Sandstone': 'orange', 'Shale': 'purple'}
    
    for rock_type in df['Rock_Type'].unique():
        data = df[df['Rock_Type'] == rock_type]
        plt.scatter(data['SiO2_percent'], data['Al2O3_percent'], 
                   c=colors[rock_type], label=rock_type, s=100, alpha=0.7)
    
    plt.xlabel('SiO2 (%)')
    plt.ylabel('Al2O3 (%)')
    plt.title('Rock Classification - SiO2 vs Al2O3')
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    # Plot 2: Geographic distribution
    plt.subplot(2, 2, 2)
    for rock_type in df['Rock_Type'].unique():
        data = df[df['Rock_Type'] == rock_type]
        plt.scatter(data['Location_Longitude'], data['Location_Latitude'], 
                   c=colors[rock_type], label=rock_type, s=100, alpha=0.7)
    
    plt.xlabel('Longitude')
    plt.ylabel('Latitude')
    plt.title('Sample Locations')
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    # Plot 3: Chemical composition by rock type
    plt.subplot(2, 2, 3)
    df_melted = df.melt(id_vars=['Sample_ID', 'Rock_Type'], 
                       value_vars=numeric_cols,
                       var_name='Oxide', value_name='Percentage')
    
    rock_means = df_melted.groupby(['Rock_Type', 'Oxide'])['Percentage'].mean().unstack()
    rock_means.plot(kind='bar', ax=plt.gca(), width=0.8)
    plt.title('Average Chemical Composition by Rock Type')
    plt.ylabel('Percentage')
    plt.xticks(rotation=45)
    plt.legend(bbox_to_anchor=(1.05, 1), loc='upper left')
    
    # Plot 4: Fe2O3 vs CaO relationship
    plt.subplot(2, 2, 4)
    for rock_type in df['Rock_Type'].unique():
        data = df[df['Rock_Type'] == rock_type]
        plt.scatter(data['Fe2O3_percent'], data['CaO_percent'], 
                   c=colors[rock_type], label=rock_type, s=100, alpha=0.7)
    
    plt.xlabel('Fe2O3 (%)')
    plt.ylabel('CaO (%)')
    plt.title('Iron vs Calcium Content')
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig('/workspace/data/geology_analysis.png', dpi=300, bbox_inches='tight')
    plt.show()
    
    return df

if __name__ == "__main__":
    print("🚀 Starting geological analysis in Docker container...")
    results = analyze_rock_samples()
    print("✅ Analysis complete! Results saved to /workspace/data/geology_analysis.png")
