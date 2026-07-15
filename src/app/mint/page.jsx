"use client";




// Contracts


import { useReadContract } from "thirdweb/react";
import { useActiveAccount } from "thirdweb/react";
import { contractSourceDAO, contractMoneyDAO } from "@/utils/functionDump/getContracts"
import { useSendTransaction } from "thirdweb/react";

import { prepareContractCall } from "thirdweb";

import { ButtonGroup, Button, Input } from "@material-tailwind/react";
import WoWUpload from "@/components/wowFileUpload";
import Link from "next/link";




const Mint = () => {












    const { mutate: DAONoMint, isPending: DAONoMintpending } = useSendTransaction();
    const handleDAONoMint = async () => {
      const punishDAOTX = prepareContractCall({
        contract: contractSourceDAO,
        method: "function NoMintPunishment()",
      });
      DAONoMint(punishDAOTX);
    };
    
    const { data: daoAmount, isLoading: daoAmountLoading } = useReadContract({
      contract: contractSourceDAO,
      method: "function amountPerMint() returns (uint256)",
    });
    const { data: nextMintableDao, isLoading: nextMintableDaoLoading } = useReadContract({
      contract: contractSourceDAO,
      method: "function nextMintable() returns (uint256)",
    });

    const dateDAO = new Date(Number(nextMintableDao) * 1000); // JS needs milliseconds
    const formattedDate = dateDAO.toLocaleString();







  

    const { mutate: MoneyNoMint, isPending: MoneyNoMintpending } = useSendTransaction();
    const handleMoneyNoMint = async () => {
      const punishMoneyTX = prepareContractCall({
        contract: contractMoneyDAO,
        method: "function NoMintPunishment()",
      });
      MoneyNoMint(punishMoneyTX);
    };

    const { data: moneyAmount, isLoading: moneyAmountLoading } = useReadContract({
      contract: contractMoneyDAO,
      method: "function amountPerMint() returns (uint256)",
    });

    const { data: nextMintablemoney, isLoading: nextMintablemoneyLoading } = useReadContract({
      contract: contractMoneyDAO,
      method: "function nextMintable() returns (uint256)",
    });
    const dateMoney = new Date(Number(nextMintablemoney) * 1000); // JS needs milliseconds
    const formattedDatemoney = dateMoney.toLocaleString();




    





    return (
      <div className='flex flex-col justify-center items-center w-full'>

      <div className="flex flex-row gap-8">

        <div className="flex flex-col justify-center items-center">
          <h2>dao reward amount: ({Number(daoAmount)})</h2>
          <h3>next mint: {formattedDate}</h3>
          <ButtonGroup>
            <Button onClick={()=> {handleDAONoMint()}}>punish</Button>
          </ButtonGroup>
        </div>


        <div className="flex flex-col justify-center items-center">
          <h2>money reward amount: ({Number(moneyAmount)})</h2>
          <h3>next mint: {formattedDatemoney}</h3>
          <ButtonGroup>
            <Button onClick={()=> {handleMoneyNoMint()}}>punish</Button>
          </ButtonGroup>
        </div>


      </div>



      <div className="flex flex-col justify-center items-center my-6">
        <a  href="https://github.com/PrivatePepega/GuildBank-App" rel="noopener noreferrer" target="_blank">
          Github Link
        </a>
        <h2>Read the github docs underneath for a better explanation</h2>
      </div>

      <WoWUpload/>
        
      </div>
    )

  
}


export default Mint
