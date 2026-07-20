# Safety Constraints

## Data Integrity
- Do not delete or overwrite original data files
- Save outputs to separate result directories
- Preserve raw data in its original format

## Interpretation Boundaries
- Do not make claims about economic viability, ore grade thresholds, or resource potential
- Do not assign geological unit names to clusters (use Cluster 1, 2, 3... or descriptive labels like "High-Cu cluster")
- Do not infer deposit type or mineralization style without explicit domain expert input

## Provenance Requirements
- Always preserve provenance: note algorithm, parameters, and input data for each result
- When imputing missing values, state the method (median, mean, KNN) and percentage of data affected
- When removing outliers, state the criterion (e.g., >3 IQR) and number of samples removed

## Reproducibility
- Use explicit random seeds when randomness is involved
- Document all preprocessing steps in order
- Note software versions for any specialized tools used

## Language
- Always respond in the same language the user is using