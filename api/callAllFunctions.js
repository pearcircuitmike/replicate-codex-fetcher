import { classifyModelsAndUpdateTags } from "./classifyModelsAndUpdateTags.js";
import { saveCostToRunHistory } from "./saveCostToRunHistory.js";
import { saveRunsHistory } from "./saveRunsHistory.js";
import { updateAllModelsPricing } from "./updatePricing.js";
import { updateModelsData } from "./updateRuns.js";

classifyModelsAndUpdateTags();
saveCostToRunHistory();
saveRunsHistory();
updateAllModelsPricing();
updateModelsData();
